// Integration: auth + CSRF surface of the admin routes.
//
// tests/setup.ts wraps global fetch and silently injects a CSRF token into every admin mutation,
// so the pre-existing suites never observe the real 401/403 responses. These cases deliberately
// call the un-wrapped fetch (__nativeFetch) to pin the actual enforcement — and the one deliberate
// exemption (first-run database import).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const nativeFetch = (globalThis as unknown as { __nativeFetch: typeof fetch }).__nativeFetch;

const dataDir = path.join(os.tmpdir(), `latedev-csrf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookie = '';

const json = () => ({ 'content-type': 'application/json' });

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

describe('admin auth surface before setup', () => {
  it('exempts the first-run database import from auth so a new instance can be seeded', async () => {
    const res = await nativeFetch(`${baseUrl}/api/admin/backup/restore`, {
      method: 'POST', headers: json(), body: JSON.stringify({ backup: {}, passphrase: '123456' }),
    });
    // Reached the handler (bad payload) instead of being turned away by auth/CSRF.
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/backup/i);
  });

  it('still requires auth for other admin mutations', async () => {
    const res = await nativeFetch(`${baseUrl}/api/admin/providers`, {
      method: 'POST', headers: json(), body: JSON.stringify({ type: 'openai' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('admin auth surface after setup', () => {
  beforeAll(async () => {
    await nativeFetch(`${baseUrl}/api/admin/setup`, {
      method: 'POST', headers: json(),
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    const login = await nativeFetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: json(),
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toBeTruthy();
  });

  it('closes the first-run import exemption once setup is complete', async () => {
    const res = await nativeFetch(`${baseUrl}/api/admin/backup/restore`, {
      method: 'POST', headers: json(), body: JSON.stringify({ backup: {}, passphrase: '123456' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an admin mutation that carries a session but no CSRF token', async () => {
    const res = await nativeFetch(`${baseUrl}/api/admin/backup/create`, {
      method: 'POST', headers: { ...json(), cookie }, body: JSON.stringify({ passphrase: '123456' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { message: string } }).error.message).toBe('CSRF token required');
  });

  it('accepts the same mutation with a session and a CSRF token', async () => {
    const csrfRes = await nativeFetch(`${baseUrl}/api/admin/csrf`, { headers: { cookie } });
    const { csrfToken } = await csrfRes.json() as { csrfToken: string };
    const res = await nativeFetch(`${baseUrl}/api/admin/backup/create`, {
      method: 'POST', headers: { ...json(), cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ passphrase: '123456' }),
    });
    expect(res.status).toBe(200);
  });
});
