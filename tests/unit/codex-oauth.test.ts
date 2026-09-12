// Codex OAuth (PKCE) flow: authorize URL shape, callback parsing, and code exchange.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_OAUTH, buildCodexAuthorizeUrl, exchangeCodexCode, extractCodeFromCallback, newCodexPkce } from '../../src/server/providers/codex-oauth';

const VERIFIER = 'v'.repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe('buildCodexAuthorizeUrl', () => {
  it('mirrors the Codex CLI authorize request', () => {
    const url = new URL(buildCodexAuthorizeUrl(VERIFIER, 'state123'));
    expect(url.origin + url.pathname).toBe(CODEX_OAUTH.authorizeUrl);
    const params = url.searchParams;
    expect(params.get('client_id')).toBe(CODEX_OAUTH.clientId);
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(params.get('scope')).toBe('openid profile email offline_access');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toBe('state123');
    expect(params.get('codex_cli_simplified_flow')).toBe('true');
    expect(params.get('id_token_add_organizations')).toBe('true');
    expect(params.get('originator')).toBe('codex_cli_rs');
    // S256 of the verifier, never the verifier itself.
    expect(params.get('code_challenge')).not.toBe(VERIFIER);
    expect(params.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  });

  it('derives a different challenge per verifier', () => {
    expect(buildCodexAuthorizeUrl('a'.repeat(64), 's')).not.toBe(buildCodexAuthorizeUrl('b'.repeat(64), 's'));
  });
});

describe('newCodexPkce', () => {
  it('produces unique, URL-safe verifiers and states', () => {
    const first = newCodexPkce();
    const second = newCodexPkce();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
    expect(first.verifier).toMatch(/^[\w-]+$/);
    expect(first.state).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('extractCodeFromCallback', () => {
  it('reads the code from a full loopback callback URL', () => {
    expect(extractCodeFromCallback('http://localhost:1455/auth/callback?code=abc123def&state=s')).toBe('abc123def');
  });
  it('accepts a bare code', () => {
    expect(extractCodeFromCallback('  abc123def  ')).toBe('abc123def');
  });
  it('rejects empty and non-code values', () => {
    expect(extractCodeFromCallback('')).toBeNull();
    expect(extractCodeFromCallback('   ')).toBeNull();
    expect(extractCodeFromCallback('not a url or code')).toBeNull();
    expect(extractCodeFromCallback('http://localhost:1455/auth/callback?state=s')).toBeNull();
  });
});

describe('exchangeCodexCode', () => {
  const token = () => ({ access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600 });

  it('posts a PKCE exchange and normalizes the credentials', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(CODEX_OAUTH.tokenUrl);
      const body = new URLSearchParams(String(init.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('abc123def');
      expect(body.get('code_verifier')).toBe(VERIFIER);
      expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(init.method).toBe('POST');
      return new Response(JSON.stringify(token()), { status: 200 });
    }) as unknown as typeof fetch;

    const record = await exchangeCodexCode({ code: 'abc123def', verifier: VERIFIER, fetchImpl });
    if ('error' in record) throw new Error('expected a usable record');
    expect(record.accessToken).toBe('a');
    expect(record.refreshToken).toBe('r');
    expect(record.source).toBe('oauth');
    expect(record.expiresAt).toBeTruthy();
  });

  it('does not leak the authorization code in the failure message', async () => {
    const secretCode = 'SECRET_CODE_VALUE_1234';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: `bad code ${secretCode}` }), { status: 400 })) as unknown as typeof fetch;
    const error = await exchangeCodexCode({ code: secretCode, verifier: VERIFIER, fetchImpl }).then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/HTTP 400/);
    expect(error?.message).not.toContain(secretCode);
    expect((error as { status?: number }).status).toBe(400);
  });

  it('rejects a token response without credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCodexCode({ code: 'c', verifier: VERIFIER, fetchImpl })).rejects.toThrow(/did not contain usable credentials/);
  });
});
