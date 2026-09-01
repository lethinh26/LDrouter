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
