// Qoder credential seam: turns an account row plus its PAT into a short-lived job token the
// chat client can sign with, and classifies attempt failures back onto account health.
//
// A PAT (`pt-…`) cannot be used directly — it is exchanged at openapi for a job token (`jt-…`).
// The exchange is coalesced per account so a burst of requests does not stampede the upstream,
// exactly like codex-refresh.ts's flight map.
import { GatewayError } from '../../errors';
import { upstreamHttpError } from '../../upstream/client';
import {
  getQoderAccountDetailById,
  getQoderAccountRefreshState,
  getQoderCredentials,
  persistQoderJobToken,
  readQoderCatalog,
  setQoderAccountHealth,
} from '../../db/repositories/qoder-accounts';
import { deserializeCatalog, exchangeQoderPat, fetchQoderCatalog, serializeCatalog, type QoderCatalog } from './catalog';

/** Refresh this far ahead of expiry so an in-flight request never crosses the boundary. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15_000;

export interface QoderRuntimeCredentials {
  qoderUserId: string;
  jobToken: string;
  machineId: string;
  catalog: QoderCatalog | null;
  email: string | null;
  label: string | null;
}

export interface QoderCredentialsResult {
  config: QoderRuntimeCredentials;
}

type FlightResult = { ok: true; config: QoderRuntimeCredentials } | { ok: false; error: 'account_not_found' | 'credential_unavailable' | 'exchange_failed' };

const flights = new Map<string, Promise<FlightResult>>();

function needsRefresh(jobTokenExpiresAt: string, now: Date): boolean {
  const expires = Date.parse(jobTokenExpiresAt);
  return !Number.isFinite(expires) || expires - now.getTime() <= REFRESH_LEAD_MS;
}

function readCatalog(accountRecordId: string): QoderCatalog | null {
  const row = readQoderCatalog(accountRecordId);
  return row?.catalogJson ? deserializeCatalog(row.catalogJson) : null;
}

async function resolveCredentials(accountRecordId: string, force: boolean, now: Date): Promise<FlightResult> {
  let state: { jobTokenExpiresAt: string } | null;
  let credentials;
  let detail;
  try {
    state = getQoderAccountRefreshState(accountRecordId);
    detail = getQoderAccountDetailById(accountRecordId);
    credentials = state ? getQoderCredentials(accountRecordId) : null;
  } catch {
    // Never surface the underlying error: a decryption failure message can echo ciphertext.
    return { ok: false, error: 'credential_unavailable' };
  }
  if (!state || !credentials || !detail) return { ok: false, error: 'account_not_found' };

  const base = { qoderUserId: detail.qoderUserId, machineId: detail.machineId, email: detail.email, label: detail.label };
  if (!force && !needsRefresh(state.jobTokenExpiresAt, now)) {
    return { ok: true, config: { ...base, jobToken: credentials.jobToken, catalog: readCatalog(accountRecordId) } };
  }

  // The PAT is the durable credential; the job token is derived and disposable. A fresh catalog
  // is fetched on the same exchange because the model list is served to the same token.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const exchanged = await exchangeQoderPat(credentials.personalToken, { signal: controller.signal });
    const catalog = await fetchQoderCatalog(
      { jobToken: exchanged.jobToken, userId: exchanged.qoderUserId || detail.qoderUserId, machineId: detail.machineId },
      { signal: controller.signal },
    ).catch(() => null);
    persistQoderJobToken(accountRecordId, {
      jobToken: exchanged.jobToken,
      expiresAt: exchanged.jobTokenExpiresAt,
      ...(catalog ? { catalogJson: serializeCatalog(catalog), catalogFetchedAt: catalog.fetchedAt } : {}),
    });
    return {
      ok: true,
      config: {
        qoderUserId: exchanged.qoderUserId || base.qoderUserId,
        machineId: base.machineId,
        jobToken: exchanged.jobToken,
        catalog: catalog ?? readCatalog(accountRecordId),
        email: exchanged.email ?? base.email,
        label: exchanged.label ?? base.label,
      },
    };
  } catch {
    // A rejected PAT is durable: the operator must replace it, so stop routing to this account.
    setQoderAccountHealth(accountRecordId, 'down', 'personal access token rejected — replace it');
    return { ok: false, error: 'exchange_failed' };
  } finally {
    clearTimeout(timer);
  }
}

function toResult(result: FlightResult): QoderCredentialsResult {
  if (result.ok) return { config: result.config };
  if (result.error === 'account_not_found') throw new GatewayError('invalid_request_error', 'Qoder account not found', { status: 404 });
  throw new GatewayError('authentication_error', 'Qoder credentials could not be refreshed — replace the personal access token', { status: 401 });
}

/**
 * Resolve a usable job token for an account, refreshing when it is inside the lead window or when
 * `force` is set. Concurrent callers share one exchange.
 */
export async function qoderCredentialsFor(accountRecordId: string, options: { force?: boolean; now?: Date } = {}): Promise<QoderCredentialsResult> {
  const force = options.force === true;
  const now = options.now ?? new Date();
  const key = `${accountRecordId}:${force ? 'force' : 'soft'}`;
  const existing = flights.get(key);
  if (existing) return toResult(await existing);
  const flight = resolveCredentials(accountRecordId, force, now).finally(() => flights.delete(key));
  flights.set(key, flight);
  return toResult(await flight);
}

/**
 * Classify a Qoder attempt failure. A rejected or expired PAT marks the account down so routing
 * skips it; a billing wall only degrades it. Both keep the credential out of the error, and both
 * fail the attempt so combo fallback proceeds.
 */
export async function qoderAttemptFailure(accountRecordId: string, error: unknown): Promise<never> {
  const status = (error as { status?: number }).status ?? 502;
  const billing = Boolean((error as { billing?: boolean }).billing);
  // Billing is checked first because a quota refusal carries status 403 (code 112) and would
  // otherwise be classified as a rejected credential: that mislabels the cause, force-re-exchanges
  // a perfectly good PAT on every request, and hides the real answer (the account is out of quota).
  if (billing) {
    setQoderAccountHealth(accountRecordId, 'degraded', 'upstream reported a quota or billing block');
    throw new GatewayError('upstream_error', 'Qoder account is out of quota', { status: 502, code: 'qoder_billing_block' });
  }
  if (status === 401 || status === 403) {
    // The PAT may still be valid — the job token may merely have expired mid-request. Force one
    // exchange before condemning the account; a second rejection is the PAT's fault.
    const retried = await qoderCredentialsFor(accountRecordId, { force: true }).catch(() => null);
    if (!retried) {
      setQoderAccountHealth(accountRecordId, 'down', 'personal access token rejected — replace it');
      throw new GatewayError('upstream_auth_error', 'Qoder account credentials were rejected — replace the personal access token', { status: 502, code: 'qoder_auth_failed' });
    }
    throw new GatewayError('upstream_auth_error', 'Qoder job token was rejected after a refresh', { status: 502, code: 'qoder_auth_failed' });
  }
  throw upstreamHttpError(status, '', error);
}

/** Probe/discover share this: a catalog is the only proof the PAT works end to end. */
export async function withQoderCredentials<T>(accountRecordId: string, fn: (config: QoderRuntimeCredentials) => Promise<T>): Promise<T> {
  const { config } = await qoderCredentialsFor(accountRecordId);
  return fn(config);
}
