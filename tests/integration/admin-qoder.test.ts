import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-qoder-http-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance;
let baseUrl = '';
let cookie = '';
let csrf = '';
let providerId = '';
let nonQoderProviderId = '';

const jsonHeaders = () => ({ 'content-type': 'application/json', cookie });
// Mutations that carry no body must not declare a JSON content-type — Fastify rejects an empty
// body with that header. This mirrors src/web/lib/api.ts, which only sets it when a body exists.
const authed = () => ({ cookie, 'x-csrf-token': csrf });
const authedJson = () => ({ ...authed(), 'content-type': 'application/json' });
const PAT = 'pt-live-token-value';

const realFetch = globalThis.fetch;

/**
 * Stub only the Qoder boundary: job token exchange, userinfo, and the model list. Everything else
 * (the test's own calls to the admin API on 127.0.0.1) must reach the server, so it falls through
 * to the captured real fetch — a blanket stub would intercept the requests under test.
 *
 * The user id is derived from the PAT so distinct tokens are distinct accounts: identity is
 * (provider_id, qoder_user_id), and a shared id would silently collapse them into one row.
 */
const stubUpstream = (overrides: { exchangeStatus?: number; catalogStatus?: number; creditsStatus?: number; chatStatus?: number } = {}) => {
  // The exchange is a POST carrying the PAT; userinfo is a GET that carries only the job token, so
  // the identity has to be remembered across the two calls.
  const byJobToken = new Map<string, string>();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('qoder.sh')) return realFetch(input, init);
    if (url.includes('jobToken/exchange')) {
      if (overrides.exchangeStatus && overrides.exchangeStatus !== 200) return new Response('{"error":"nope"}', { status: overrides.exchangeStatus });
      const pat = String(init?.body ?? '').match(/"personal_token":"([^"]*)"/)?.[1] ?? 'anon';
      // Distinct PATs must map to distinct accounts: identity is (provider_id, qoder_user_id).
      const userId = `qu-${Buffer.from(pat).toString('hex') || 'anon'}`;
      byJobToken.set('jt-minted-job-token', userId);
      return new Response(JSON.stringify({ token: 'jt-minted-job-token', id: userId, email: `${userId}@example.com`, name: 'Dev' }), { status: 200 });
    }
    if (url.includes('userinfo')) {
      const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace('Bearer ', '');
      const userId = byJobToken.get(auth) ?? 'qu-anon';
      return new Response(JSON.stringify({ id: userId, email: `${userId}@example.com`, name: 'Dev' }), { status: 200 });
    }
    if (overrides.catalogStatus && overrides.catalogStatus !== 200) return new Response('{"error":"nope"}', { status: overrides.catalogStatus });
    // Credits live on the same openapi host as userinfo, so they must be matched explicitly:
    // falling through would hand the credits parser a model list.
    if (url.includes('/quota/usage')) {
      if (overrides.creditsStatus && overrides.creditsStatus !== 200) return new Response('{"error":"nope"}', { status: overrides.creditsStatus });
      return new Response(JSON.stringify({ userType: 'personal_standard', isQuotaExceeded: true, totalUsagePercentage: 0, userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' } }), { status: 200 });
    }
    // Inference: the account "Test" button now sends a real message, so the chat endpoint has to
    // answer with an envelope. `chatStatus` 403 carries the billing code the upstream really uses.
    // Matched on the chat sig path, not `/algo/` — the model list lives under the same prefix.
    if (url.includes('agent_chat_generation')) {
      const envelope = overrides.chatStatus === 403
        ? { statusCodeValue: 403, body: '{"code":"112","message":"quota exhausted"}' }
        : { statusCodeValue: 200, body: JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'pong' } }] }) };
      return new Response(`data: ${JSON.stringify(envelope)}\n\n`, { status: 200 });
    }
    return new Response(JSON.stringify({ chat: [{ key: 'qmodel_38max', display_name: 'Qwen 38 Max', is_free: true, max_input_tokens: 200000, max_output_tokens: 32000 }] }), { status: 200 });
  }));
};

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { getRawDb } = await import('../../src/server/db');
  const raw = getRawDb();
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('qoder-provider','Qoder','qoder','qoder','https://api2.qoder.sh')").run();
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('openai-provider','OpenAI','openai','openai','https://openai.invalid')").run();
  providerId = 'qoder-provider';
  nonQoderProviderId = 'openai-provider';
  const sessionToken = cookie.slice('ld_session='.length);
  const { sha256Hex } = await import('../../src/server/auth/ids');
  const session = raw.prepare('SELECT id FROM admin_sessions WHERE token_digest=?').get(sha256Hex(sessionToken)) as { id: string };
  csrf = (raw.prepare('SELECT token FROM csrf_tokens WHERE session_id=?').get(session.id) as { token: string }).token;
  expect(csrf).toBeTruthy();
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await app.close(); (await import('../../src/server/db')).closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('authenticated Qoder admin HTTP API', () => {
  it('reports an out-of-Credits account as failing rather than "connected"', async () => {
    stubUpstream({ chatStatus: 403 });
    const body = await (await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, personalToken: 'pt-billing', label: 'Billing' }) })).json() as { account: { id: string } };
    const tested = await (await fetch(`${baseUrl}/api/admin/qoder/accounts/${body.account.id}/test`, { method: 'POST', headers: authedJson(), body: JSON.stringify({}) })).json() as { ok: boolean; detail: string };
    // The catalog loads and the PAT exchanges, which is exactly why a catalog-only probe lied.
    expect(tested.ok).toBe(false);
    expect(tested.detail).toContain('out of Credits');
    const listed = await (await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } })).json() as { accounts: Array<{ id: string; healthState: string }> };
    expect(listed.accounts.find((account) => account.id === body.account.id)!.healthState).toBe('down');
  });

  it('requires a session and CSRF for every route', async () => {
    const noSession = await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`);
    expect(noSession.status).toBe(401);
    const add = await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': 'wrong' }, body: JSON.stringify({ providerId, personalToken: PAT }) });
    expect(add.status).toBe(403);
    const list = await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } });
    expect(list.status).toBe(200);
  });

  it('rejects a non-Qoder provider and an unknown provider', async () => {
    stubUpstream();
    const wrongType = await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId: nonQoderProviderId, personalToken: PAT }) });
    expect(wrongType.status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId: 'nope', personalToken: PAT }) });
    expect(missing.status).toBe(404);
  });

  it('adds a PAT account and never returns or stores it in plaintext', async () => {
    stubUpstream();
    const res = await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, personalToken: PAT, label: 'Dev' }) });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(PAT);
    expect(raw).not.toContain('jt-minted-job-token');
    const body = JSON.parse(raw) as { account: { id: string; qoderUserIdMasked: string; label: string } };
    expect(body.account.label).toBe('Dev');
    expect(body.account.qoderUserIdMasked).toMatch(/^qu-.*….*$/);

    const { getRawDb } = await import('../../src/server/db');
    const row = getRawDb().prepare('SELECT encrypted_pat AS pat, encrypted_job_token AS job, qoder_user_id AS uid FROM qoder_accounts WHERE id=?').get(body.account.id) as { pat: string; job: string; uid: string };
    expect(row.uid).toMatch(/^qu-[0-9a-f]+$/);
    expect(row.pat).not.toContain(PAT);
    expect(row.job).not.toContain('jt-minted-job-token');
  });

  it('stores nothing when the PAT is rejected', async () => {
    stubUpstream({ exchangeStatus: 401 });
    const before = (await (await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } })).json() as { accounts: unknown[] }).accounts.length;
    const res = await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, personalToken: 'pt-dead-token' }) });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('pt-dead-token');
    const after = (await (await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } })).json() as { accounts: unknown[] }).accounts.length;
    expect(after).toBe(before);
  });

  it('still stores the account when only the catalog fetch fails', async () => {
    stubUpstream({ catalogStatus: 502 });
    const res = await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, personalToken: 'pt-catalog-502', label: 'CatalogDown' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { catalogError: string | null; account: { healthState: string; lastError: string | null } };
    expect(body.catalogError).toBeTruthy();
    expect(body.account.healthState).toBe('unknown');
    expect(body.account.lastError).toBeTruthy();
  });

  it('rejects a non-pt token with a message naming the requirement', async () => {
    stubUpstream();
    const res = await fetch(`${baseUrl}/api/admin/qoder/accounts/import`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, text: 'dt-nope' }) });
    const body = await res.json() as { failed: number; results: Array<{ error: string }> };
    expect(body.failed).toBe(1);
    expect(body.results[0]!.error).toContain('pt-');
  });

  it('imports two valid lines, reports one failure, and masks tokens in the response', async () => {
    stubUpstream();
    const res = await fetch(`${baseUrl}/api/admin/qoder/accounts/import`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, text: 'pt-aaa\npt-bbb\ndt-bad' }) });
    const body = await res.json() as { added: number; failed: number; results: Array<Record<string, unknown>> };
    expect(body.added).toBe(2);
    expect(body.failed).toBe(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('pt-aaa');
    expect(raw).not.toContain('pt-bbb');
    const masked = body.results.find((r) => r.status === 'inserted')!.masked as string;
    expect(masked).toContain('…');
  });

  it('re-importing the same token updates instead of duplicating', async () => {
    stubUpstream();
    const first = await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, personalToken: 'pt-stable-identity' }) });
    const firstBody = await first.json() as { account: { id: string } };
    const res = await fetch(`${baseUrl}/api/admin/qoder/accounts/import`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, text: 'pt-stable-identity' }) });
    const body = await res.json() as { added: number; updated: number };
    expect(body).toMatchObject({ added: 0, updated: 1 });
    const accounts = await (await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } })).json() as { accounts: Array<{ id: string }> };
    expect(accounts.accounts.filter((a) => a.id === firstBody.account.id)).toHaveLength(1);
    expect(firstBody.account.id).toBeTruthy();
  });

  it('lists masked summaries and never a token', async () => {
    stubUpstream();
    const res = await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } });
    const body = await res.json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts.length).toBeGreaterThan(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(PAT);
    expect(raw).not.toContain('pt-');
    for (const account of body.accounts) {
      expect(account).not.toHaveProperty('qoderUserId');
      expect(account).not.toHaveProperty('machineId');
      expect(account).not.toHaveProperty('encryptedPat');
    }
  });

  it('supports PATCH, reorder, delete, and the test/catalog probes', async () => {
    stubUpstream();
    const created = await (await fetch(`${baseUrl}/api/admin/qoder/accounts`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, personalToken: 'pt-mutable', label: 'Before' }) })).json() as { account: { id: string } };
    const id = created.account.id;

    const patched = await fetch(`${baseUrl}/api/admin/qoder/accounts/${id}`, { method: 'PATCH', headers: authedJson(), body: JSON.stringify({ label: 'After', enabled: false }) });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as { account: { label: string; enabled: boolean } };
    expect(patchedBody.account).toMatchObject({ label: 'After', enabled: false });
    const empty = await fetch(`${baseUrl}/api/admin/qoder/accounts/${id}`, { method: 'PATCH', headers: authedJson(), body: JSON.stringify({}) });
    expect(empty.status).toBe(400);

    const list = await (await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } })).json() as { accounts: Array<{ id: string }> };
    const ids = list.accounts.map((account) => account.id).reverse();
    const reordered = await fetch(`${baseUrl}/api/admin/qoder/accounts/reorder`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, ids }) });
    expect(reordered.status).toBe(200);
    const reorderedBody = await reordered.json() as { accounts: Array<{ id: string; priority: number }> };
    expect(reorderedBody.accounts.map((a) => a.id)).toEqual(ids);
    const foreign = await fetch(`${baseUrl}/api/admin/qoder/accounts/reorder`, { method: 'POST', headers: authedJson(), body: JSON.stringify({ providerId, ids: ['not-mine'] }) });
    expect(foreign.status).toBe(400);

    const tested = await fetch(`${baseUrl}/api/admin/qoder/accounts/${id}/test`, { method: 'POST', headers: authedJson(), body: JSON.stringify({}) });
    expect(tested.status).toBe(200);
    const testedBody = await tested.json() as { ok: boolean; detail: string; modelCount: number };
    expect(testedBody.ok).toBe(true);
    expect(testedBody.detail).toContain('Inference OK');
    expect(testedBody.modelCount).toBe(1);

    const catalog = await fetch(`${baseUrl}/api/admin/qoder/accounts/${id}/catalog`, { method: 'POST', headers: authedJson(), body: JSON.stringify({}) });
    const catalogBody = await catalog.json() as { modelCount: number; modelKeys: string[] };
    expect(catalogBody.modelCount).toBe(1);
    expect(catalogBody.modelKeys).toEqual(['qmodel_38max']);
    expect(JSON.stringify(catalogBody)).not.toContain('catalogJson');

    // Credits are the account's real usage (Qoder streams no tokens), so the refresh route must
    // report them and persist them onto the summary the UI renders.
    const credits = await fetch(`${baseUrl}/api/admin/qoder/accounts/${id}/credits`, { method: 'POST', headers: authedJson(), body: JSON.stringify({}) });
    expect(credits.status).toBe(200);
    const creditsBody = await credits.json() as { account: { credits: { userType: string; exhausted: boolean; freeModels: string[] } } };
    expect(creditsBody.account.credits).toMatchObject({ userType: 'personal_standard', exhausted: true });
    // is_free comes off the cached catalog, which is why the catalog refresh above ran first.
    expect(creditsBody.account.credits.freeModels).toEqual(['qmodel_38max']);

    const listed = await (await fetch(`${baseUrl}/api/admin/qoder/accounts?providerId=${providerId}`, { headers: { cookie } })).json() as { accounts: Array<{ id: string; credits: unknown; creditsUpdatedAt: string | null }> };
    const persisted = listed.accounts.find((account) => account.id === id)!;
    expect(persisted.credits).toMatchObject({ exhausted: true, freeModels: ['qmodel_38max'] });
    expect(persisted.creditsUpdatedAt).toBeTruthy();

    const deleted = await fetch(`${baseUrl}/api/admin/qoder/accounts/${id}`, { method: 'DELETE', headers: authed() });
    expect(deleted.status).toBe(200);
    const gone = await fetch(`${baseUrl}/api/admin/qoder/accounts/${id}`, { method: 'PATCH', headers: authedJson(), body: JSON.stringify({ label: 'x' }) });
    expect(gone.status).toBe(404);

    const { getRawDb } = await import('../../src/server/db');
    const actions = (getRawDb().prepare("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'qoder.accounts.%'").all() as Array<{ action: string }>).map((row) => row.action);
    for (const expected of ['qoder.accounts.add', 'qoder.accounts.import', 'qoder.accounts.test', 'qoder.accounts.delete', 'qoder.accounts.update', 'qoder.accounts.reorder', 'qoder.accounts.catalog', 'qoder.accounts.credits']) {
      expect(actions).toContain(expected);
    }
  });
});
