import { getCodexCredentials, getCodexAccountRefreshState, persistCodexRefresh, setCodexAccountHealth, type DecryptedCodexCredentials } from '../db/repositories/codex-accounts';
import { CODEX_OAUTH } from './codex-oauth';
import { GatewayError } from '../errors';

/**
 * Maps the credential-layer's opaque error codes onto typed admin-facing errors. Call sites that
 * must not leak a bare 500 wrap their `withCodexCredentials` call in this. Codex fixes credential
 * failures by re-importing the account, not by re-saving a provider API key.
 */
export function codexCredentialError(error: unknown): unknown {
  const code = error instanceof Error ? error.message : '';
  if (code === 'account_not_found') return new GatewayError('invalid_request_error', 'Codex account not found', { status: 404 });
  if (code === 'oauth_refresh_unavailable' || code === 'invalid_refresh_response') {
    // Transient: the token is probably still good, so the operator should retry, not re-import.
    // Same wrapping as the final verdict (the routing layer sees one credential class either way)
    // but the message must not send them to the import dialog over one flaky attempt.
    return new GatewayError('authentication_error', 'Codex credentials could not be refreshed — try again', { status: 401, cause: error });
  }
  if (code === 'oauth_refresh_failed' || code === 'credential_unavailable') {
    // `cause` carries the raw credential code: the wrapping message is deliberately generic, so
    // without it the routing layer cannot tell a dead account from any other authentication_error.
    return new GatewayError('authentication_error', 'Codex credentials could not be refreshed — re-import the account', { status: 401, cause: error });
  }
  return error;
}

export interface CodexRefreshAccount {
  tokenExpiresAt: string;
}

export interface OAuthRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
  expiresAt?: string;
}

/**
 * Refresh outcomes, split by whether the account heals on its own or needs an operator.
 *
 * 9router splits the same way (`classifyOAuthRefreshError` → `unrecoverable_refresh_error`): only a
 * grant the endpoint actually rejected is final. Collapsing every failure into one code is what
 * broke production — a timeout, a token-endpoint 5xx, a malformed 200 or a rolled-back DB write all
 * surfaced as `oauth_refresh_failed`, which the gateway reads as "these credentials are dead", so
 * it degraded the account and evicted it (`enabled=0`) on one flaky moment. Every live account
 * carried `consecutive_failures = 0`: the counter built to require a pattern before a verdict was
 * never incremented, because a single failure was already treated as final.
 */
export type CodexRefreshFailure =
  | 'oauth_refresh_failed' // permanent — the endpoint rejected the grant
  | 'credential_unavailable' // permanent — the stored credentials cannot be read
  | 'account_not_found' // permanent — the row is gone
  | 'oauth_refresh_unavailable' // transient — the attempt failed, the token may still be good
  | 'invalid_refresh_response'; // transient — a 200 carrying nothing usable

export type SafeRefreshResult = {
  ok: true;
  expiresAt: string;
} | {
  ok: false;
  error: CodexRefreshFailure;
};

/** Only a final verdict may retire an account; a transient failure leaves it in the pool. */
const PERMANENT_REFRESH_FAILURES = new Set<CodexRefreshFailure>(['oauth_refresh_failed', 'credential_unavailable', 'account_not_found']);

export function isPermanentRefreshFailure(error: CodexRefreshFailure): boolean {
  return PERMANENT_REFRESH_FAILURES.has(error);
}

export type OAuthRefreshClient = (input: { refreshToken: string; signal: AbortSignal }) => Promise<OAuthRefreshResponse>;

const REFRESH_LEAD_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;
const flights = new Map<string, Promise<SafeRefreshResult>>();
let refreshClient: OAuthRefreshClient = defaultRefreshClient;
let refreshTimeoutMs = REFRESH_TIMEOUT_MS;

export function configureCodexOAuthRefreshClient(client: OAuthRefreshClient | null, timeoutMs = REFRESH_TIMEOUT_MS): void {
  refreshClient = client ?? defaultRefreshClient;
  refreshTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REFRESH_TIMEOUT_MS;
}

export function needsCodexRefresh(account: CodexRefreshAccount, now = new Date()): boolean {
  const expires = Date.parse(account.tokenExpiresAt);
  return !Number.isFinite(expires) || expires - now.getTime() <= REFRESH_LEAD_MS;
}

async function defaultRefreshClient(input: { refreshToken: string; signal: AbortSignal }): Promise<OAuthRefreshResponse> {
  const response = await fetch(CODEX_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    // `client_id` is required: without it the endpoint answers 400 `Missing 'client_id'`,
    // which surfaced as an opaque refresh failure and left expired tokens unusable.
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: input.refreshToken, client_id: CODEX_OAUTH.clientId }),
    signal: input.signal,
  });
  if (!response.ok) {
    // The RFC 6749 error body is what separates a dead grant from a bad moment; `safeError` classifies
    // on it. Only the resulting code is ever persisted, never this text.
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`oauth refresh http ${response.status}`), { status: response.status, oauthError: detail });
  }
  const value = await response.json() as Record<string, unknown>;
  if (typeof value.access_token !== 'string' || !value.access_token) throw new Error('invalid refresh response');
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
    idToken: typeof value.id_token === 'string' ? value.id_token : undefined,
    expiresIn: typeof value.expires_in === 'number' ? value.expires_in : undefined,
    expiresAt: typeof value.expires_at === 'string' ? value.expires_at : undefined,
  };
}

/** Grant rejections the endpoint answers with; only these mean the refresh token is dead. */
const REJECTED_GRANT_MARKERS = ['invalid_grant', 'refresh_token_invalidated', 'refresh_token_reused', 'refresh_token_expired', 'session has ended'];

/**
 * Decides whether a failed refresh is a verdict or just a failed attempt.
 *
 * A marker only counts when the endpoint itself rejected the grant (4xx): a 5xx or a gateway error
 * page that happens to echo `invalid_grant` is still transient. Anything without a marker — a
 * timeout, a DNS error, an aborted request, a rolled-back write — is transient by default, so an
 * account is never retired on evidence this layer does not actually have.
 */
function safeError(error: unknown): CodexRefreshFailure {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 500) return 'oauth_refresh_unavailable';
  const oauthError = (error as { oauthError?: unknown } | null)?.oauthError;
  const text = `${(error as Error | null)?.message ?? ''} ${typeof oauthError === 'string' ? oauthError : ''}`.toLowerCase();
  return REJECTED_GRANT_MARKERS.some((marker) => text.includes(marker)) ? 'oauth_refresh_failed' : 'oauth_refresh_unavailable';
}

/** Degrades an account for a final verdict only — a transient failure must leave health alone. */
function markDegraded(accountId: string, error: CodexRefreshFailure): void {
  try { setCodexAccountHealth(accountId, 'degraded', error); } catch { /* fail closed */ }
}

async function refreshOnce(accountId: string, now: Date, force: boolean): Promise<SafeRefreshResult> {
  let state;
  try { state = getCodexAccountRefreshState(accountId); } catch {
    // A row that cannot be read is an operator problem, not a failed refresh: it needs a re-import,
    // so the account leaves the pool instead of burning an attempt on every request.
    markDegraded(accountId, 'credential_unavailable');
    return { ok: false, error: 'credential_unavailable' };
  }
  if (!state) return { ok: false, error: 'account_not_found' };
  if (!force && !needsCodexRefresh(state, now)) return { ok: true, expiresAt: state.tokenExpiresAt };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
  try {
    const result = await refreshClient({ refreshToken: state.refreshToken, signal: controller.signal });
    if (typeof result.accessToken !== 'string' || !result.accessToken) {
      // A 200 with nothing usable is suspicious, not proof the grant is dead: the next attempt may
      // succeed, so the account keeps its health and stays in the pool.
      return { ok: false, error: 'invalid_refresh_response' };
    }
    const expiresAt = result.expiresAt ?? (typeof result.expiresIn === 'number' && Number.isFinite(result.expiresIn) && result.expiresIn > 0
      ? new Date(now.getTime() + result.expiresIn * 1000).toISOString()
      : '');
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
      return { ok: false, error: 'invalid_refresh_response' };
    }
    try {
      persistCodexRefresh(accountId, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? state.refreshToken,
      idToken: result.idToken ?? state.idToken,
      expiresAt,
      });
    } catch {
      // The transaction rolled back, so the stored token is unchanged and still usable.
      return { ok: false, error: 'oauth_refresh_unavailable' };
    }
    return { ok: true, expiresAt };
  } catch (error) {
    const failure = safeError(error);
    if (isPermanentRefreshFailure(failure)) markDegraded(accountId, failure);
    return { ok: false, error: failure };
  } finally {
    clearTimeout(timer);
  }
}

export function refreshCodexAccount(accountId: string, now = new Date(), force = false): Promise<SafeRefreshResult> {
  const existing = flights.get(accountId);
  if (existing) return existing;
  const flight = refreshOnce(accountId, now, force).finally(() => flights.delete(accountId));
  flights.set(accountId, flight);
  return flight;
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && ('status' in error) && (((error as { status: unknown }).status === 401) || ((error as { status: unknown }).status === 403)));
}

/* eslint-disable preserve-caught-error -- raw credential errors must never escape this boundary */
export async function withCodexCredentials<T>(accountId: string, fn: (credentials: DecryptedCodexCredentials) => Promise<T>, now = new Date()): Promise<T> {
  let state;
  try { state = getCodexAccountRefreshState(accountId); } catch {
    markDegraded(accountId, 'credential_unavailable');
    throw new Error('credential_unavailable', { cause: new Error('credential_unavailable') });
  }
  if (!state) throw new Error('account_not_found');
  if (needsCodexRefresh(state, now)) {
    const refreshed = await refreshCodexAccount(accountId, now);
    if (!refreshed.ok) throw new Error(refreshed.error, { cause: new Error(refreshed.error) });
  }
  let credentials;
  try { credentials = getCodexCredentials(accountId); } catch {
    markDegraded(accountId, 'credential_unavailable');
    throw new Error('credential_unavailable', { cause: new Error('credential_unavailable') });
  }
  try {
    return await fn(credentials);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    const refreshed = await refreshCodexAccount(accountId, now, true);
    if (!refreshed.ok) throw new Error(refreshed.error, { cause: new Error(refreshed.error) });
    try { credentials = getCodexCredentials(accountId); } catch {
      markDegraded(accountId, 'credential_unavailable');
      throw new Error('credential_unavailable', { cause: new Error('credential_unavailable') });
    }
    return fn(credentials);
  }
}
/* eslint-enable preserve-caught-error */
