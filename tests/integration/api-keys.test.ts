import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';

const dataDir = path.join(os.tmpdir(), `latedev-ak-test-${Date.now()}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  }).then((r) => { if (!r.ok) throw new Error(`setup ${r.status}`); });
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  cookies = loginRes.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('re-readable API key secrets', () => {
  it('create → list returns same secret (decrypted from DB)', async () => {
    const createRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ name: 'test-key', allowAllModels: true }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { id: string; secret: string; name: string };
    expect(created.secret).toBeTruthy();
    const listRes = await fetch(`${baseUrl}/api/admin/api-keys`, { headers: { cookie: cookies } });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { apiKeys: Array<{ id: string; secret: string | null }> };
    const found = list.apiKeys.find((k) => k.id === created.id);
    expect(found).toBeTruthy();
    expect(found!.secret).toBe(created.secret);
  });

  it('custom secret is stored verbatim, returned on list, digest matches, ciphertext differs', async () => {
    const customSecret = 'ld-my-custom-key-1234567890';
    const createRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ name: 'custom-key', allowAllModels: true, secret: customSecret }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { id: string; secret: string };
    expect(created.secret).toBe(customSecret);
    const { sha256Hex } = await import('../../src/server/auth/ids');
    const { getDb, schema } = await import('../../src/server/db/index');
    const row = getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, created.id)).get();
    expect(row!.keyDigest).toBe(sha256Hex(customSecret));
    expect(row!.keySecretEncrypted).toBeTruthy();
    expect(row!.keySecretEncrypted).not.toContain(customSecret);
  });

  it('key with no stored secret returns secret: null', async () => {
    const { uuid, generateApiKeySecret, sha256Hex } = await import('../../src/server/auth/ids');
    const { getDb, schema } = await import('../../src/server/db/index');
    const legacySecret = generateApiKeySecret();
    getDb().insert(schema.apiKeys).values({
      id: uuid(), name: 'legacy', keyPrefix: legacySecret.slice(0, 11),
      keyDigest: sha256Hex(legacySecret), enabled: true, allowAllModels: true,
    }).run();
    const listRes = await fetch(`${baseUrl}/api/admin/api-keys`, { headers: { cookie: cookies } });
    const list = await listRes.json() as { apiKeys: Array<{ id: string; secret: string | null; name: string }> };
    const legacy = list.apiKeys.find((k) => k.name === 'legacy');
    expect(legacy?.secret).toBeNull();
  });

  it('list survives a key encrypted with a different master key (restore from another instance)', async () => {
    const { uuid, generateApiKeySecret, sha256Hex } = await import('../../src/server/auth/ids');
    const { getDb, schema } = await import('../../src/server/db/index');
    const otherSecret = generateApiKeySecret();
    // Simulate a key row restored from another instance: its ciphertext was
    // produced with a master key the running gateway does not know, so AES-GCM
    // auth fails ("Unsupported state or unable to authenticate data").
    const invalid = Buffer.from('not-a-valid-ciphertext-under-any-key').toString('base64');
    getDb().insert(schema.apiKeys).values({
      id: uuid(), name: 'other-instance', keyPrefix: otherSecret.slice(0, 11),
      keyDigest: sha256Hex(otherSecret), enabled: true, allowAllModels: true,
      keySecretEncrypted: invalid, keySecretNonce: Buffer.from('0123456789ab').toString('base64'), keySecretVersion: 1,
    }).run();

    // The list must NOT crash: the undecryptable row yields secret: null and
    // the healthy rows still resolve.
    const listRes = await fetch(`${baseUrl}/api/admin/api-keys`, { headers: { cookie: cookies } });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { apiKeys: Array<{ id: string; secret: string | null; name: string }> };
    const other = list.apiKeys.find((k) => k.name === 'other-instance');
    expect(other?.secret).toBeNull();
    const custom = list.apiKeys.find((k) => k.name === 'custom-key');
    expect(custom?.secret).toBeTruthy();
  });

  it('creating a key with an already-used secret returns a readable 409', async () => {
    const createRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ name: 'dup', allowAllModels: true, secret: 'ld-same-secret-1234567890' }),
    });
    expect(createRes.status).toBe(200);
    const secondRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ name: 'dup2', allowAllModels: true, secret: 'ld-same-secret-1234567890' }),
    });
    expect(secondRes.status).toBe(409);
    const body = await secondRes.json() as { error: { message: string } };
    expect(body.error.message).toContain('already exists');
  });
});

describe('API key lifecycle and limits', () => {
  const adminHeaders = () => ({ 'content-type': 'application/json', cookie: cookies });

  it('creates, edits, disables, enables, expires, revokes and deletes a configured key', async () => {
    const config = {
      name: 'bounded-key', allowAllModels: true, rpmLimit: 10, tpmLimit: 2000,
      dailyTokenLimit: 3000, monthlyTokenLimit: 4000, totalTokenLimit: 5000,
      maxConcurrent: 2, maxOutputTokensPerRequest: 128, cacheOverrideEnabled: false,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ipRules: [{ mode: 'allow', cidr: '127.0.0.1/32' }],
    };
    const created = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify(config),
    });
    expect(created.status).toBe(200);
    const { id, secret } = await created.json() as { id: string; secret: string };
    const detail = async () => {
      const res = await fetch(`${baseUrl}/api/admin/api-keys/${id}`, { headers: adminHeaders() });
      expect(res.status).toBe(200);
      return (await res.json()).apiKey;
    };
    const patch = async (body: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/api/admin/api-keys`, {
        method: 'PATCH', headers: adminHeaders(), body: JSON.stringify({ id, ...body }),
      });
      expect(res.status).toBe(200);
    };
    const listModels = () => fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
    expect(await detail()).toMatchObject({ ...config, totalTokensUsed: 0, secret });
    expect((await listModels()).status).toBe(200);
    const list = await fetch(`${baseUrl}/api/admin/api-keys`, { headers: adminHeaders() });
    expect((await list.json()).apiKeys.find((key: { id: string }) => key.id === id)).toMatchObject({
      totalTokenLimit: 5000, maxOutputTokensPerRequest: 128, lastUsedAt: expect.any(String),
    });
    await patch({ name: 'edited', totalTokenLimit: null, dailyTokenLimit: null, maxOutputTokensPerRequest: 32, cacheOverrideEnabled: true });
    expect(await detail()).toMatchObject({ name: 'edited', secret, totalTokenLimit: null, dailyTokenLimit: null, maxOutputTokensPerRequest: 32, cacheOverrideEnabled: true });
    await patch({ enabled: false });
    expect((await listModels()).status).toBe(401);
    await patch({ enabled: true });
    expect((await listModels()).status).toBe(200);
    await patch({ expiresAt: '2000-01-01T00:00:00.000Z' });
    expect((await listModels()).status).toBe(401);
    await patch({ expiresAt: null, ipRules: [{ mode: 'allow', cidr: '127.0.0.1' }, { mode: 'deny', cidr: '127.0.0.1' }] });
    expect((await listModels()).status).toBe(403);
    const count = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': secret },
      body: JSON.stringify({ model: 'missing', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(count.status).toBe(403);
    await patch({ ipRules: [] });
    expect((await listModels()).status).toBe(200);
    const revoked = await fetch(`${baseUrl}/api/admin/api-keys/${id}/revoke`, { method: 'POST', headers: { cookie: cookies } });
    expect(revoked.status).toBe(200);
    expect((await listModels()).status).toBe(401);
    const deleted = await fetch(`${baseUrl}/api/admin/api-keys/${id}`, { method: 'DELETE', headers: { cookie: cookies } });
    expect(deleted.status).toBe(200);
    expect((await listModels()).status).toBe(401);
  });

  it.each([
    { totalTokenLimit: 0 }, { totalTokenLimit: 1.5 },
    { expiresAt: 'not-a-date' }, { ipRules: [{ mode: 'deny', cidr: '127.0.0.1/nope' }] },
    { permissions: [{ targetKind: 'model', targetId: 'duplicate' }, { targetKind: 'model', targetId: 'duplicate' }] },
  ])('rejects invalid configuration: %j', async (invalid) => {
    const res = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: 'invalid', ...invalid }),
    });
    expect(res.status).toBe(400);
  });

  it('reserves lifetime quota across simultaneous requests and counts historical months', async () => {
    const res = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: 'reserve', totalTokenLimit: 100 }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: string };
    const { getDb, schema } = await import('../../src/server/db/index');
    const { reserveQuota, consumeUsage } = await import('../../src/server/routing/quota');
    getDb().insert(schema.usageMonthly).values({ month: '2000-01', apiKeyId: id, inputTokens: 20, outputTokens: 10, totalTokens: 30 }).run();
    const limits = { dailyTokenLimit: null, monthlyTokenLimit: null, totalTokenLimit: 100 };
    const first = reserveQuota(id, limits, 50);
    expect(first.result.allowed).toBe(true);
    expect(reserveQuota(id, limits, 30).result).toEqual({ allowed: false, reason: 'total' });
    first.reservation!.release();
    const second = reserveQuota(id, limits, 70);
    expect(second.result.allowed).toBe(true);
    consumeUsage(id, 50, 20);
    second.reservation!.release();
    expect(reserveQuota(id, limits, 1).result).toEqual({ allowed: false, reason: 'total' });
    expect(reserveQuota(id, { ...limits, totalTokenLimit: null, dailyTokenLimit: 70 }, 1).result).toEqual({ allowed: false, reason: 'daily' });
    expect(reserveQuota(id, { ...limits, totalTokenLimit: null, monthlyTokenLimit: 70 }, 1).result).toEqual({ allowed: false, reason: 'monthly' });
    const detail = await fetch(`${baseUrl}/api/admin/api-keys/${id}`, { headers: adminHeaders() });
    expect((await detail.json()).apiKey.totalTokensUsed).toBe(100);
  });
});
