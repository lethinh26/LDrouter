import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-mk-test-${Date.now()}`);
// NO LATEDEV_MASTER_KEY set — ask setup to auto-gen
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
// Ensure key env is absent
delete process.env.LATEDEV_MASTER_KEY;

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // Setup — no LATEDEV_MASTER_KEY set, so the handler must auto-generate.
  const res = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  if (!res.ok) throw new Error(`setup ${res.status}`);
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('auto-generated master key', () => {
  it('setup created master.key file with a 44-char base64 key', () => {
    const keyPath = path.join(dataDir, 'master.key');
    expect(fs.existsSync(keyPath)).toBe(true);
    const content = fs.readFileSync(keyPath, 'utf8').trim();
    expect(content.length).toBe(44); // 32 bytes base64 produces 44 chars
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