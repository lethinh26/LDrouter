// Account-pool providers: the upstream credential is a pool of accounts stored in a
// dedicated table, not one API key on the provider row. The registry keeps the
// per-type probe/discover/account branches out of the provider CRUD route.
import { GatewayError } from '../errors';
import { listCodexAccountSummaries, getCodexAccountById } from '../db/repositories/codex-accounts';
import { probeCodex, codexModels, CODEX_BASE_URL } from './codex';
import { withCodexCredentials, codexCredentialError } from './codex-refresh';
import type { DiscoveredModel, ProbeResult } from './index';

export const POOLED_PROVIDER_TYPES = ['codex'] as const;
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
  // is a lookup, not a second gate — an imported account without a chatgpt_account_id is still
  // probed, and the upstream answers honestly. Returning 503 here instead would skip the audit.
  probe: async (provider) => {
    const account = firstEligible(codexStrategy.listAccounts(provider.id));
    const accountId = getCodexAccountById(account.id)?.chatgptAccountId ?? '';
    return withCodexCredentials(account.id, (credentials) => probeCodex({
      baseUrl: provider.baseUrl, accountId, accessToken: credentials.accessToken,
      accountRecordId: account.id, customHeaders: {}, totalTimeoutMs: Math.min(provider.totalTimeoutMs, 20_000),
    })).catch((error) => { throw codexCredentialError(error); });
  },
  discover: async (provider) => {
    const account = firstEligible(codexStrategy.listAccounts(provider.id));
    const accountId = getCodexAccountById(account.id)?.chatgptAccountId ?? '';
    return withCodexCredentials(account.id, (credentials) => codexModels({
      baseUrl: provider.baseUrl, accountId, accessToken: credentials.accessToken,
      accountRecordId: account.id, customHeaders: {}, totalTimeoutMs: Math.min(provider.totalTimeoutMs, 30_000),
    })).catch((error) => { throw codexCredentialError(error); });
  },
};

const STRATEGIES: Record<PooledProviderType, PooledProvider> = { codex: codexStrategy };
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
