import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `latedev-delete-test-${Date.now()}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance;
let baseUrl = '';
let cookie = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${address.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'delete-test-password-1234' }),
  });
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'delete-test-password-1234' }),
  });
  cookie = login.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  await app.close();
  (await import('../../src/server/db')).closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('admin entity deletion', () => {
  it('hard-deletes API keys, models, and providers with dependent configuration', async () => {
    const { getDb, schema } = await import('../../src/server/db');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const providerId = uuid();
    const modelId = uuid();
    const comboId = uuid();
    const aliasId = uuid();
    db.insert(schema.providers).values({ id: providerId, name: 'Delete provider', slug: `delete-${providerId.slice(0, 8)}`, type: 'openai', baseUrl: 'https://example.com', encryptedApiKey: null, apiKeyNonce: null }).run();
    db.insert(schema.models).values({ id: modelId, providerId, upstreamModelId: 'delete-model', publicModelId: `delete/${modelId}`, displayName: 'Delete model', capabilitiesJson: '{}', enabled: true, upstreamAvailable: true }).run();
    db.insert(schema.combos).values({ id: comboId, name: 'Delete combo', slug: `delete-${comboId.slice(0, 8)}`, publicModelId: `combo/delete-${comboId.slice(0, 8)}`, mode: 'fallback', enabled: true }).run();
    db.insert(schema.comboMembers).values({ id: uuid(), comboId, modelId, position: 0, enabled: true }).run();
    db.insert(schema.modelAliases).values({ id: aliasId, alias: `delete-alias-${aliasId.slice(0, 8)}`, targetKind: 'model', targetId: modelId, enabled: true }).run();

    const keyResponse = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Delete key', allowAllModels: true }),
    });
    expect(keyResponse.status).toBe(200);
    const key = await keyResponse.json() as { id: string };

    const deleteKey = await fetch(`${baseUrl}/api/admin/api-keys/${key.id}`, { method: 'DELETE', headers: { cookie } });
    expect(deleteKey.status).toBe(200);
    expect(db.select().from(schema.apiKeys).all().some((row) => row.id === key.id)).toBe(false);

    const deleteModel = await fetch(`${baseUrl}/api/admin/models/${modelId}`, { method: 'DELETE', headers: { cookie } });
    expect(deleteModel.status).toBe(200);
    expect(db.select().from(schema.models).all().some((row) => row.id === modelId)).toBe(false);
    expect(db.select().from(schema.comboMembers).all().some((row) => row.modelId === modelId)).toBe(false);
    expect(db.select().from(schema.modelAliases).all().some((row) => row.id === aliasId)).toBe(false);

    const deleteProvider = await fetch(`${baseUrl}/api/admin/providers/${providerId}`, { method: 'DELETE', headers: { cookie } });
    expect(deleteProvider.status).toBe(200);
    expect(db.select().from(schema.providers).all().some((row) => row.id === providerId)).toBe(false);
  });
});
