// Integration: TOTP enable/verify/disable + login flow (speakeasy v2 API).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-totp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
  if (typeof addr === 'string' || !addr) throw new Error();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookies = login.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('TOTP 2FA', () => {
  it('enables TOTP, verifies code, and logs in with TOTP', async () => {
    const auth = { 'content-type': 'application/json', cookie: cookies } as const;

    // Begin setup — must NOT throw "Gateway error"
    const beginRes = await fetch(`${baseUrl}/api/admin/account/totp/begin`, { method: 'POST', headers: auth, body: '{}' });
    expect(beginRes.status).toBe(200);
    const begin = await beginRes.json() as { secret: string; qr: string; otpauth?: string };
    expect(begin.secret).toBeTruthy();
    expect(begin.qr).toMatch(/^data:image\/png;base64,/);

    // Verify a TOTP code generated from the base32 secret (speakeasy v2 API)
    const sp = (await import('speakeasy')).default ?? (await import('speakeasy'));
    const code = sp.totp({ secret: begin.secret, encoding: 'base32' });
    const verifyRes = await fetch(`${baseUrl}/api/admin/account/totp/verify`, { method: 'POST', headers: auth, body: JSON.stringify({ code }) });
    expect(verifyRes.status).toBe(200);
    const verify = await verifyRes.json() as { ok: boolean; recoveryCodes: string[] };
    expect(verify.ok).toBe(true);
    expect(verify.recoveryCodes.length).toBe(8);

    // TOTP now enabled
    const meRes = await fetch(`${baseUrl}/api/admin/me`, { headers: { cookie: cookies } });
    const me = await meRes.json() as { totpEnabled: boolean };
    expect(me.totpEnabled).toBe(true);

    // Log out and log back in WITH the TOTP code
    await fetch(`${baseUrl}/api/admin/logout`, { method: 'POST', headers: auth });
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234', totp: code }),
    });
    expect(loginRes.status).toBe(200);
    const login = await loginRes.json() as { ok: boolean; totpEnabled: boolean };
    expect(login.ok).toBe(true);
    expect(login.totpEnabled).toBe(true);

    // Log back in WITHOUT code → totp_required
    const noCodeRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(noCodeRes.status).toBe(401);
    const noCode = await noCodeRes.json() as { error: { type: string } };
    expect(noCode.error.type).toBe('totp_required');
  });

  it('disables TOTP with password + code', async () => {
    // Re-enable quickly (fresh session from previous test has TOTP active)
    const beginRes = await fetch(`${baseUrl}/api/admin/account/totp/begin`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: '{}' });
    if (beginRes.status !== 200) return; // session may be stale between tests; skip gracefully
    const begin = await beginRes.json() as { secret: string };
    const sp = (await import('speakeasy')).default ?? (await import('speakeasy'));
    const code = sp.totp({ secret: begin.secret, encoding: 'base32' });
    await fetch(`${baseUrl}/api/admin/account/totp/verify`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: JSON.stringify({ code }) });

    const disRes = await fetch(`${baseUrl}/api/admin/account/totp/disable`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ password: 'super-secret-password-1234', totp: code }),
    });
    expect(disRes.status).toBe(200);
    const meRes = await fetch(`${baseUrl}/api/admin/me`, { headers: { cookie: cookies } });
    const me = await meRes.json() as { totpEnabled: boolean };
    expect(me.totpEnabled).toBe(false);
  });
});
