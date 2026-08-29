// Integration: secret redaction in persisted request logs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-redact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let secret = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookies = login.headers.get('set-cookie') ?? '';
  // Provider pointing at unreachable upstream
  await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'demo', slug: 'demo', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-LD-DEMO-KEY-123456789012', enabled: true, totalTimeoutMs: 5000 }),
  });
  const db = (await import('../../src/server/db/index')).getDb();
  const { uuid } = await import('../../src/server/auth/ids');
  const providers = db.select().from((await import('../../src/server/db/schema')).providers).all();
  db.insert((await import('../../src/server/db/schema')).models).values({
    id: uuid(), providerId: providers[0]!.id, upstreamModelId: 'm',
    publicModelId: 'demo/m', displayName: 'M', enabled: true, upstreamAvailable: true,
    capabilitiesJson: JSON.stringify({ chat: true, streaming: true }),
  }).run();
  const keyRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'k', allowAllModels: true }),
  });
  secret = (await keyRes.json() as { secret: string }).secret;
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('secret redaction', () => {
  it('upstream api key never appears in DB', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const rows = db.select().from((await import('../../src/server/db/schema')).providers).all();
    for (const r of rows) {
      expect(r.encryptedApiKey).not.toContain('LD-DEMO-KEY');
      expect(r.encryptedApiKey).not.toContain('sk-LD-DEMO');
    }
  });

  it('plaintext ld- key never appears in DB or error responses', async () => {
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'demo/m', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const db = (await import('../../src/server/db/index')).getDb();
    const dump = JSON.stringify({
      requests: db.select().from((await import('../../src/server/db/schema')).requests).all(),
      attempts: db.select().from((await import('../../src/server/db/schema')).requestAttempts).all(),
    });
    // Secret should not appear
    expect(dump).not.toContain(secret);
    // Encrypted key should not appear in plaintext
    expect(dump).not.toContain('LD-DEMO-KEY');
  });
});
