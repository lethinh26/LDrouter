import { getCodexCredentials, getCodexAccountRefreshState, persistCodexRefresh, setCodexAccountHealth, type DecryptedCodexCredentials } from '../db/repositories/codex-accounts';

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

export type SafeRefreshResult = {
  ok: true;
  expiresAt: string;
} | {
  ok: false;
  error: 'oauth_refresh_failed' | 'account_not_found' | 'invalid_refresh_response';
};

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
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: input.refreshToken }),
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`oauth refresh http ${response.status}`);
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

function safeError(_error: unknown): 'oauth_refresh_failed' {
  return 'oauth_refresh_failed';
}

function markDegraded(accountId: string, error: 'oauth_refresh_failed' | 'invalid_refresh_response'): void {
  try { setCodexAccountHealth(accountId, 'degraded', error); } catch { /* fail closed */ }
}

async function refreshOnce(accountId: string, now: Date, force: boolean): Promise<SafeRefreshResult> {
  let state;
  try { state = getCodexAccountRefreshState(accountId); } catch (error) {
    markDegraded(accountId, safeError(error));
    return { ok: false, error: 'oauth_refresh_failed' };
  }
  if (!state) return { ok: false, error: 'account_not_found' };
  if (!force && !needsCodexRefresh(state, now)) return { ok: true, expiresAt: state.tokenExpiresAt };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
  try {
    const result = await refreshClient({ refreshToken: state.refreshToken, signal: controller.signal });
    if (typeof result.accessToken !== 'string' || !result.accessToken) {
      markDegraded(accountId, 'invalid_refresh_response');
      return { ok: false, error: 'invalid_refresh_response' };
    }
    const expiresAt = result.expiresAt ?? (typeof result.expiresIn === 'number' && Number.isFinite(result.expiresIn) && result.expiresIn > 0
      ? new Date(now.getTime() + result.expiresIn * 1000).toISOString()
      : '');
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
      markDegraded(accountId, 'invalid_refresh_response');
      return { ok: false, error: 'invalid_refresh_response' };
    }
    try {
      persistCodexRefresh(accountId, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? state.refreshToken,
      idToken: result.idToken ?? state.idToken,
      expiresAt,
      });
    } catch (error) {
      markDegraded(accountId, safeError(error));
      return { ok: false, error: 'oauth_refresh_failed' };
    }
    return { ok: true, expiresAt };
  } catch (error) {
    markDegraded(accountId, safeError(error));
    return { ok: false, error: 'oauth_refresh_failed' };
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
  try { state = getCodexAccountRefreshState(accountId); } catch (error) {
    markDegraded(accountId, safeError(error));
    throw new Error('credential_unavailable', { cause: new Error('credential_unavailable') });
  }
  if (!state) throw new Error('account_not_found');
  if (needsCodexRefresh(state, now)) {
    const refreshed = await refreshCodexAccount(accountId, now);
    if (!refreshed.ok) throw new Error(refreshed.error, { cause: new Error(refreshed.error) });
  }
  let credentials;
  try { credentials = getCodexCredentials(accountId); } catch (error) {
    markDegraded(accountId, safeError(error));
    throw new Error('credential_unavailable', { cause: new Error('credential_unavailable') });
  }
  try {
    return await fn(credentials);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    const refreshed = await refreshCodexAccount(accountId, now, true);
    if (!refreshed.ok) throw new Error(refreshed.error, { cause: new Error(refreshed.error) });
    try { credentials = getCodexCredentials(accountId); } catch (credentialError) {
      markDegraded(accountId, safeError(credentialError));
      throw new Error('credential_unavailable', { cause: new Error('credential_unavailable') });
    }
    return fn(credentials);
  }
}
/* eslint-enable preserve-caught-error */
