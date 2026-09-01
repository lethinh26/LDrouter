// Integration: admin-site IP access control (Settings → Access Control).
// The gate covers the whole admin website (login/setup/static/admin APIs) but
// never model traffic (/v1/*) or /health.
//
// The server listens on 127.0.0.1 (IPv4 only), so every test connection arrives
// with req.ip === '127.0.0.1' on any platform — assertions stay deterministic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-ipgate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
  });
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

/** Direct DB write so a list can be set WITHOUT the lockout guard adding the caller IP. */
async function setLists(allow: string | null, block: string | null): Promise<void> {
  const { getDb, schema } = await import('../../src/server/db/index');
  getDb().update(schema.appSettings).set({ adminIpAllow: allow, adminIpBlock: block }).run();
}

describe('admin-site IP access control', () => {
  it('no lists configured: everything reachable', async () => {
    const res = await fetch(`${baseUrl}/api/admin/providers`, { headers: { cookie: cookies } });
    expect(res.status).toBe(200);
  });

  it('block list matching the client IP kicks out the whole site (API + login), but /health stays open', async () => {
    await setLists(null, '127.0.0.1');
    const apiRes = await fetch(`${baseUrl}/api/admin/providers`, { headers: { cookie: cookies } });
    expect(apiRes.status).toBe(403);
    expect(await apiRes.text()).toContain('Không có quyền truy cập');
    // Login endpoint is gated too (full-site decision).
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(loginRes.status).toBe(403);
    // Operational endpoint stays reachable.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.ok).toBe(true);
    await setLists(null, null);
  });

  it('allow list NOT matching the client IP rejects; a matching CIDR passes', async () => {
    await setLists('10.0.0.0/8', null);
    const res = await fetch(`${baseUrl}/api/admin/providers`, { headers: { cookie: cookies } });
    expect(res.status).toBe(403);
    await setLists('127.0.0.0/8', null);
    const ok = await fetch(`${baseUrl}/api/admin/providers`, { headers: { cookie: cookies } });
    expect(ok.status).toBe(200);
    await setLists(null, null);
  });

  it('PATCH validates CIDR entries and rejects invalid ones', async () => {
    const res = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ adminIpBlock: 'not-an-ip' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('Invalid entry');
  });

  it('lockout guard: saving a non-empty allow list auto-adds the caller IP', async () => {
    const res = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ adminIpAllow: '10.0.0.0/8' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; addedIp: string | null };
    expect(body.addedIp).toBe('127.0.0.1');
    // The list on disk contains both the configured range and the caller IP.
    const { getSettings } = await import('../../src/server/db/repositories/settings');
    const s = getSettings();
    expect(s.adminIpAllow).toContain('10.0.0.0/8');
    expect(s.adminIpAllow).toContain('127.0.0.1');
    // And the site remains reachable for the caller.
    const ok = await fetch(`${baseUrl}/api/admin/providers`, { headers: { cookie: cookies } });
    expect(ok.status).toBe(200);
    await setLists(null, null);
  });
});
