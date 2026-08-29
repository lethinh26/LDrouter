import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-mk-test-${Date.now()}`);
// NO LATEDEV_MASTER_KEY set — setup must require an explicit key.
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
// Ensure key env is absent
delete process.env.LATEDEV_MASTER_KEY;

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
// A valid key: plain 32-character string (also accepted: 32 bytes as 44-char base64).
const MASTER_KEY = 'x'.repeat(32);

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('setup master key requirement', () => {
  it('setup without master key is rejected (no auto-generation)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toContain('Master');
  });

  it('setup with short master key is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/admin/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234', setupMasterKey: 'short' }),
    });
    expect(res.status).toBe(400);
  });

  it('setup with a 32+ char master key succeeds and persists master.key', async () => {
    const res = await fetch(`${baseUrl}/api/admin/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234', setupMasterKey: MASTER_KEY }),
    });
    expect(res.status).toBe(200);
    const keyPath = path.join(dataDir, 'master.key');
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath, 'utf8').trim()).toBe(MASTER_KEY);
  });

  it('provider creation succeeds in same process (regression for config cache bug)', async () => {
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(loginRes.status).toBe(200);
    const cookies = loginRes.headers.get('set-cookie') ?? '';
    // This returned 503 before the setConfigMasterKey cache fix.
    const provRes = await fetch(`${baseUrl}/api/admin/providers`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({
        name: 'test', slug: 'test', type: 'openai',
        baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test',
        enabled: true, totalTimeoutMs: 5000,
      }),
    });
    expect(provRes.status).toBe(200);
  });
});
