// Integration: hot database restore (POST /api/admin/backup/restore).
//
// Verifies the gateway reloads the restored database in-process — no restart
// needed — and that the admin session survives the swap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-br-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let providerId = '';

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
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  cookies = loginRes.headers.get('set-cookie') ?? '';
  expect(cookies).toBeTruthy();

  // Seed a provider + model A so the database has real content to back up.
  const db = (await import('../../src/server/db/index')).getDb();
  const { uuid } = await import('../../src/server/auth/ids');
  const schema = await import('../../src/server/db/schema');
  providerId = uuid();
  db.insert(schema.providers).values({
    id: providerId, name: 'p', slug: 'p', type: 'openai',
    baseUrl: 'http://127.0.0.1:9', encryptedApiKey: 'x', apiKeyNonce: 'x', apiKeyVersion: 1, enabled: true,
  }).run();
  db.insert(schema.models).values({
    id: uuid(), providerId, upstreamModelId: 'a', publicModelId: 'p/a',
    displayName: 'Model A', enabled: true, upstreamAvailable: true, capabilitiesJson: '{}',
  }).run();
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('hot restore', () => {
  it('replaces the database in-process and keeps the admin session', async () => {
    // 1. Download a backup of the current (2-row) database.
    const createRes = await fetch(`${baseUrl}/api/admin/backup/create`, {
      method: 'POST', headers: { cookie: cookies },
    });
    expect(createRes.status).toBe(200);
    const envelope = await createRes.json() as Record<string, unknown>;

    // 2. Mutate the live database AFTER the backup: add model B.
    const db = (await import('../../src/server/db/index')).getDb();
    const { uuid } = await import('../../src/server/auth/ids');
    const schema = await import('../../src/server/db/schema');
    db.insert(schema.models).values({
      id: uuid(), providerId, upstreamModelId: 'b', publicModelId: 'p/b',
      displayName: 'Model B', enabled: true, upstreamAvailable: true, capabilitiesJson: '{}',
    }).run();
    const beforeRes = await fetch(`${baseUrl}/api/admin/models`, { headers: { cookie: cookies } });
    const before = await beforeRes.json() as { models: Array<{ publicModelId: string }> };
    expect(before.models.map((m) => m.publicModelId)).toContain('p/b');

    // 3. Restore the backup. This closes + reopens the DB inside the running
    //    process (no restart) and re-seeds the admin session.
    const restoreRes = await fetch(`${baseUrl}/api/admin/backup/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify(envelope),
    });
    expect(restoreRes.status).toBe(200);

    // 4. Same process, same server instance, same cookie — the database is now
    //    the restored snapshot (model B gone) and the session still validates.
    const afterRes = await fetch(`${baseUrl}/api/admin/models`, { headers: { cookie: cookies } });
    expect(afterRes.status).toBe(200);
    const after = await afterRes.json() as { models: Array<{ publicModelId: string }> };
    const ids = after.models.map((m) => m.publicModelId);
    expect(ids).toContain('p/a');
    expect(ids).not.toContain('p/b');

    // 5. The in-process DB handle now points at the restored file.
    const db2 = (await import('../../src/server/db/index')).getDb();
    const all = db2.select().from(schema.models).all();
    expect(all.length).toBe(1);
    expect(all[0]!.publicModelId).toBe('p/a');
  });

  it('rejects an invalid backup without touching the database', async () => {
    const res = await fetch(`${baseUrl}/api/admin/backup/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ format: 'latedev-backup', version: 1, payload: 'bm90LXNxbGl0ZQ==', checksum: 'deadbeef' }),
    });
    expect(res.status).toBe(400);

    const db = (await import('../../src/server/db/index')).getDb();
    const schema = await import('../../src/server/db/schema');
    const all = db.select().from(schema.models).all();
    expect(all.length).toBe(1);
    expect(all[0]!.publicModelId).toBe('p/a');
  });
});
