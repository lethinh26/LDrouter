import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-pool-create-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance;
let baseUrl = '';
let cookie = '';
let csrf = '';

const post = (body: unknown) => fetch(`${baseUrl}/api/admin/providers`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body),
});

const patch = (body: unknown) => fetch(`${baseUrl}/api/admin/providers`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body),
});

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { getRawDb } = await import('../../src/server/db');
  const { sha256Hex } = await import('../../src/server/auth/ids');
  const session = getRawDb().prepare('SELECT id FROM admin_sessions WHERE token_digest=?').get(sha256Hex(cookie.slice('ld_session='.length))) as { id: string };
  csrf = (getRawDb().prepare('SELECT token FROM csrf_tokens WHERE session_id=?').get(session.id) as { token: string }).token;
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => { await app.close(); (await import('../../src/server/db')).closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const codexRows = async () => {
  const { getRawDb } = await import('../../src/server/db');
  return getRawDb().prepare("SELECT id,name,slug,base_url,encrypted_api_key FROM providers WHERE type='codex'").all() as Array<{ id: string; name: string; slug: string; base_url: string; encrypted_api_key: string | null }>;
};

describe('one-click account-pool provider creation', () => {
  it('creates a Codex provider from its type alone without storing an API key it is sent', async () => {
    // Spec §5.7: a pool type has no API-key field, so a key in the body must not be encrypted onto
    // the row. (`name`/`slug`/`baseUrl` stay request-overridable — see the fix report's ruling.)
    const res = await post({ type: 'codex', apiKey: 'sk-should-not-be-stored' });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; slug: string };
    expect(body.slug).toBe('codex');
    const rows = await codexRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: body.id, name: 'Codex', slug: 'codex', base_url: 'https://chatgpt.com', encrypted_api_key: null });
  });

  it('rejects a second pool provider of the same type with slug_taken naming the existing provider', async () => {
    const res = await post({ type: 'codex' });
    expect(res.status).toBe(400);
    const error = await res.json() as { error: { message: string; code: string } };
    expect(error.error.code).toBe('slug_taken');
    expect(error.error.message).toContain('Codex'); // names the provider that already exists
    // Nothing was inserted by the rejected request.
    expect(await codexRows()).toHaveLength(1);
  });

  it('passes a degraded account id to the upstream call instead of 503ing and marking the provider down', async () => {
    const { getRawDb } = await import('../../src/server/db');
    const providerId = (await codexRows())[0]!.id;
    const { upsertCodexAccount, setCodexAccountHealth } = await import('../../src/server/db/repositories/codex-accounts');
    const accountId = upsertCodexAccount(providerId, {
      index: 0, email: 'degraded@example.com', workspaceId: 'ws-1', chatgptAccountId: 'acct-degraded', planType: 'plus',
      expiresAt: '2030-01-01T00:00:00.000Z', accessToken: 'access-degraded', refreshToken: 'refresh-degraded', idToken: null,
      identity: 'account:acct-degraded',
    }).id;
    // `degraded` is refreshable, not a reason to refuse: the old route read the column unconditionally.
    setCodexAccountHealth(accountId, 'degraded');

    const passthrough = globalThis.fetch;
    const seen: Array<string | null> = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://chatgpt.com/')) return passthrough(input, init);
      seen.push(new Headers(init?.headers).get('chatgpt-account-id'));
      return Promise.resolve(new Response(JSON.stringify({ models: [{ slug: 'gpt-5-codex' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });

    const test = await fetch(`${baseUrl}/api/admin/providers/${providerId}/test`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: '{}' });
    expect(test.status).toBe(200);
    const discover = await fetch(`${baseUrl}/api/admin/providers/${providerId}/discover`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: '{}' });
    expect(discover.status).toBe(200);

    expect(seen).toEqual(['acct-degraded', 'acct-degraded']);
    const health = getRawDb().prepare('SELECT health_state AS healthState FROM providers WHERE id=?').get(providerId) as { healthState: string };
    expect(health.healthState).toBe('healthy');
  });

  it('refuses to store an API key PATCHed onto a pool provider', async () => {
    // Same §5.7 invariant as the create path, one call path over: a pool type has no API-key field,
    // so PATCH must leave encrypted_api_key/api_key_nonce/api_key_version untouched.
    const providerId = (await codexRows())[0]!.id;
    const res = await patch({ id: providerId, apiKey: 'sk-patched-onto-a-pool-provider' });
    expect(res.status).toBe(200);
    const { getRawDb } = await import('../../src/server/db');
    const stored = getRawDb().prepare('SELECT encrypted_api_key AS key, api_key_nonce AS nonce FROM providers WHERE id=?').get(providerId) as { key: string | null; nonce: string | null };
    expect(stored).toEqual({ key: null, nonce: null });
  });

  it('still requires base URL and API key for a compatible provider', async () => {
    const res = await post({ type: 'openai', name: 'OpenAI' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('API key is required');
  });
});
