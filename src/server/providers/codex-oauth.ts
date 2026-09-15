// Codex OAuth (PKCE) authorization-code flow, mirroring the Codex CLI client:
// fixed loopback port, S256 challenge, and a form-encoded token exchange.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NormalizedCodexRecord } from './codex-import';
import { normalizeCodexRecord } from './codex-import';

export const CODEX_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  codeChallengeMethod: 'S256',
  /** Codex CLI registers http://localhost:1455/auth/callback, so the port is not negotiable. */
  callbackUrl: 'http://localhost:1455/auth/callback',
};

/** Server-side auth URL: challenge always derives from the verifier the exchange will use. */
export function buildCodexAuthorizeUrl(verifier: string, state: string): string {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH.clientId,
    redirect_uri: CODEX_OAUTH.callbackUrl,
    scope: CODEX_OAUTH.scope,
    code_challenge: challenge,
    code_challenge_method: CODEX_OAUTH.codeChallengeMethod,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
    state,
  });
  return `${CODEX_OAUTH.authorizeUrl}?${params.toString()}`;
}

export function newCodexPkce(): { verifier: string; state: string } {
  return { verifier: randomBytes(64).toString('base64url'), state: randomUUID().replace(/-/g, '') };
}

/** The browser lands on the loopback redirect; operators may paste that URL or just its code. */
export function extractCodeFromCallback(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const code = new URL(text).searchParams.get('code');
    if (code) return code;
  } catch { /* not a URL — fall through to the bare-code case */ }
  return /^[\w.~-]{8,}$/.test(text) ? text : null;
}

interface ExchangeOptions {
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Exchanges the authorization code for tokens; never echoes the code or token values. */
export async function exchangeCodexCode({ code, verifier, fetchImpl = fetch, timeoutMs = 30_000 }: ExchangeOptions): Promise<NormalizedCodexRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(CODEX_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CODEX_OAUTH.callbackUrl,
        client_id: CODEX_OAUTH.clientId,
        code_verifier: verifier,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !body) {
      // Deliberately generic: provider error bodies can echo the authorization code.
      throw Object.assign(new Error(`Codex authorization failed (HTTP ${response.status})`), { status: response.status });
    }
    const record = normalizeCodexRecord(body, 0, new Date(), 'oauth');
    if ('error' in record) throw new Error('Codex token response did not contain usable credentials');
    return record;
  } finally { clearTimeout(timer); }
}
