// Account-pool providers: the upstream credential is a pool of accounts stored in a
// dedicated table, not one API key on the provider row. The registry keeps the
// per-type probe/discover/account branches out of the provider CRUD route.
import { GatewayError } from '../errors';
import { listCodexAccountSummaries, chatgptAccountIdOf } from '../db/repositories/codex-accounts';
import { listQoderAccountSummaries } from '../db/repositories/qoder-accounts';
import { probeCodex, codexModels, CODEX_BASE_URL } from './codex';
import { withCodexCredentials, codexCredentialError } from './codex-refresh';
import { probeQoderInference, qoderModels } from './qoder/client';
import { withQoderCredentials } from './qoder/credentials';
import { QODER_INFERENCE_BASE } from './qoder/constants';
import type { DiscoveredModel, ProbeResult } from './index';

export const POOLED_PROVIDER_TYPES = ['codex', 'qoder'] as const;
export type PooledProviderType = (typeof POOLED_PROVIDER_TYPES)[number];

export interface PooledAccountSummary { id: string; enabled: boolean; healthState: string }

export interface PooledProviderTarget {
  id: string;
  baseUrl: string;
  totalTimeoutMs: number;
}

export interface PooledProvider {
  /** Provider-row defaults used when the admin creates this type with one click. */
  defaults: { name: string; slug: string; baseUrl: string };
  listAccounts(providerId: string): PooledAccountSummary[];
  probe(provider: PooledProviderTarget): Promise<ProbeResult>;
  discover(provider: PooledProviderTarget): Promise<DiscoveredModel[]>;
  /** Account ids to delete in the same transaction as the provider row. */
  accountsTable: string;
}

function firstEligible(accounts: PooledAccountSummary[]): PooledAccountSummary {
  const account = accounts.find((candidate) => candidate.enabled && candidate.healthState !== 'down');
  if (!account) throw new GatewayError('authentication_error', 'No eligible account is configured for this provider', { status: 503 });
  return account;
}

const codexStrategy: PooledProvider = {
  defaults: { name: 'Codex', slug: 'codex', baseUrl: CODEX_BASE_URL },
  accountsTable: 'codex_accounts',
  listAccounts: (providerId) => listCodexAccountSummaries(providerId),
  // `firstEligible` is the single eligibility gate (matching the route it replaces); the account id
  // is a plain lookup, not a second gate — an imported account without a chatgpt_account_id is still
  // probed, and a degraded or token-expired account is still refreshable, so the upstream answers
  // honestly instead of the route short-circuiting to 503 (which would also skip the audit write).
  probe: async (provider) => {
    const account = firstEligible(codexStrategy.listAccounts(provider.id));
    const accountId = chatgptAccountIdOf(account.id) ?? '';
    return withCodexCredentials(account.id, (credentials) => probeCodex({
      baseUrl: provider.baseUrl, accountId, accessToken: credentials.accessToken,
      accountRecordId: account.id, customHeaders: {}, totalTimeoutMs: Math.min(provider.totalTimeoutMs, 20_000),
    })).catch((error) => { throw codexCredentialError(error); });
  },
  discover: async (provider) => {
    const account = firstEligible(codexStrategy.listAccounts(provider.id));
    const accountId = chatgptAccountIdOf(account.id) ?? '';
    return withCodexCredentials(account.id, (credentials) => codexModels({
      baseUrl: provider.baseUrl, accountId, accessToken: credentials.accessToken,
      accountRecordId: account.id, customHeaders: {}, totalTimeoutMs: Math.min(provider.totalTimeoutMs, 30_000),
    })).catch((error) => { throw codexCredentialError(error); });
  },
};

const qoderStrategy: PooledProvider = {
  defaults: { name: 'Qoder', slug: 'qoder', baseUrl: QODER_INFERENCE_BASE },
  accountsTable: 'qoder_accounts',
  listAccounts: (providerId) => listQoderAccountSummaries(providerId),
  // Same contract as Codex: `firstEligible` is the single eligibility gate, and the probe goes
  // through the credential seam so a stale job token is refreshed before the upstream is asked.
  probe: async (provider) => {
    const account = firstEligible(qoderStrategy.listAccounts(provider.id));
    // Inference, not just the catalog — see probeQoderInference: a catalog probe cannot see the
    // billing envelope that Qoder returns with HTTP 200 when an account is out of Credits.
    return withQoderCredentials(account.id, (config) => probeQoderInference({ ...config, accountRecordId: account.id, totalTimeoutMs: Math.min(provider.totalTimeoutMs, 30_000) }))
      .catch((error) => { throw qoderCredentialError(error); });
  },
  discover: async (provider) => {
    const account = firstEligible(qoderStrategy.listAccounts(provider.id));
    return withQoderCredentials(account.id, (config) => {
      if (!config.catalog) throw new GatewayError('invalid_request_error', 'Qoder model catalog is empty — the account has no usable models', { status: 400, code: 'model_config_not_cached' });
      return Promise.resolve(qoderModels(config.catalog));
    }).catch((error) => { throw qoderCredentialError(error); });
  },
};

/** Qoder fixes credential failures by replacing the PAT, not by re-saving a provider API key. */
function qoderCredentialError(error: unknown): unknown {
  if (error instanceof GatewayError) return error;
  const code = error instanceof Error ? error.message : '';
  if (code === 'account_not_found') return new GatewayError('invalid_request_error', 'Qoder account not found', { status: 404 });
  return error;
}

const STRATEGIES: Record<PooledProviderType, PooledProvider> = { codex: codexStrategy, qoder: qoderStrategy };
/** null for types the registry does not own (openai / anthropic-compatible keep the generic path). */
export function getPooledProvider(type: string): PooledProvider | null {
  return (STRATEGIES as Record<string, PooledProvider>)[type] ?? null;
}

/** Throws for a non-pool type so callers cannot read undefined defaults. */
export function pooledProviderDefaults(type: string): PooledProvider['defaults'] {
  const strategy = getPooledProvider(type);
  if (!strategy) throw new GatewayError('invalid_request_error', `Provider type '${type}' is not an account-pool provider`, { status: 400 });
  return strategy.defaults;
}
