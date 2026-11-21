// Integration: alias create/update validates the destination and reserves public model IDs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-alias-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let modelA = '';
let modelB = '';
type DB = ReturnType<(typeof import('../../src/server/db/index'))['getDb']>;
let db: DB;
let sch: typeof import('../../src/server/db/schema');

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
  });
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  cookies = login.headers.get('set-cookie') ?? '';

  db = (await import('../../src/server/db/index')).getDb();
  sch = await import('../../src/server/db/schema');
  const { uuid } = await import('../../src/server/auth/ids');
  const now = new Date().toISOString();
  db.insert(sch.providers).values({
    id: 'alias-provider', name: 'Alias provider', slug: 'alias-provider', type: 'openai',
    baseUrl: 'http://127.0.0.1:1', encryptedApiKey: 'x', apiKeyNonce: 'y', apiKeyVersion: 1,
    enabled: true, createdAt: now, updatedAt: now,
  }).run();
  modelA = uuid();
  modelB = uuid();
  db.insert(sch.models).values([
    { id: modelA, providerId: 'alias-provider', upstreamModelId: 'model-a', publicModelId: 'alias-provider/model-a', displayName: 'Model A', enabled: true, upstreamAvailable: true, capabilitiesJson: '{}' },
    { id: modelB, providerId: 'alias-provider', upstreamModelId: 'model-b', publicModelId: 'alias-provider/model-b', displayName: 'Model B', enabled: true, upstreamAvailable: true, capabilitiesJson: '{}' },
    { id: uuid(), providerId: 'alias-provider', upstreamModelId: 'reserved', publicModelId: 'reserved', displayName: 'Reserved ID', enabled: true, upstreamAvailable: true, capabilitiesJson: '{}' },
  ]).run();
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const post = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/admin/aliases`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: JSON.stringify(body),
});

const patch = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/admin/aliases`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies }, body: JSON.stringify(body),
});

const createCombo = (name: string) => fetch(`${baseUrl}/api/admin/combos`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
  body: JSON.stringify({ mode: 'fallback', name, members: [{ modelId: modelA, position: 0, enabled: true }] }),
});

const list = async () => {
  const response = await fetch(`${baseUrl}/api/admin/aliases`, { headers: { cookie: cookies } });
  expect(response.status).toBe(200);
  return (await response.json()).aliases as Array<{ id: string; alias: string; targetKind: string; targetId: string; targetName: string; enabled: boolean }>;
};

describe('admin alias create and edit', () => {
  it('creates a normalized alias and returns its destination', async () => {
    const response = await post({ alias: 'Coding Alias', targetKind: 'model', targetId: modelA });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ alias: 'coding-alias' });
    await expect(list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: 'coding-alias', targetKind: 'model', targetId: modelA, targetName: 'alias-provider/model-a', enabled: true }),
    ]));
  });

  it('updates the alias, destination and enabled state together', async () => {
    const created = await (await post({ alias: 'to-update', targetKind: 'model', targetId: modelA })).json();
    const response = await patch({ id: created.id, alias: 'fast-route', targetKind: 'model', targetId: modelB, enabled: false });
    expect(response.status).toBe(200);
    await expect(list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, alias: 'fast-route', targetId: modelB, targetName: 'alias-provider/model-b', enabled: false }),
    ]));
  });

  it('rejects an alias that is already owned by another row without changing the original', async () => {
    const first = await (await post({ alias: 'first-route', targetKind: 'model', targetId: modelA })).json();
    await post({ alias: 'second-route', targetKind: 'model', targetId: modelB });
    const response = await patch({ id: first.id, alias: 'second-route' });
    expect(response.status).toBe(400);
    await expect(list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, alias: 'first-route' }),
    ]));
  });

  it('rejects an update when the selected destination no longer exists', async () => {
    const created = await (await post({ alias: 'valid-route', targetKind: 'model', targetId: modelA })).json();
    const response = await patch({ id: created.id, targetId: 'missing-model' });
    expect(response.status).toBe(400);
    await expect(list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, alias: 'valid-route', targetId: modelA }),
    ]));
  });

  it('rejects aliases that shadow an existing physical model ID', async () => {
    const response = await post({ alias: 'reserved', targetKind: 'model', targetId: modelA });
    expect(response.status).toBe(400);
    expect(((await response.json()).error.message as string)).toMatch(/shadows/i);
  });

  it('supports combo destinations and reserves their public IDs', async () => {
    const comboResponse = await createCombo('Reserved Combo');
    expect(comboResponse.status).toBe(200);
    const combo = await comboResponse.json();

    const created = await post({ alias: 'combo-route', targetKind: 'combo', targetId: combo.id });
    expect(created.status).toBe(200);
    const alias = await created.json();
    await expect(list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alias.id, alias: 'combo-route', targetKind: 'combo', targetId: combo.id, targetName: 'reserved-combo' }),
    ]));

    const shadow = await post({ alias: 'reserved-combo', targetKind: 'model', targetId: modelA });
    expect(shadow.status).toBe(400);
    expect(((await shadow.json()).error.message as string)).toMatch(/shadows/i);
  });

  it('allows a status-only update without revalidating an unchanged destination', async () => {
    const created = await (await post({ alias: 'status-only', targetKind: 'model', targetId: modelA })).json();
    const response = await patch({ id: created.id, enabled: false });
    expect(response.status).toBe(200);
    await expect(list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, alias: 'status-only', enabled: false }),
    ]));
  });
});
