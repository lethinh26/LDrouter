import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-pool-create-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance;
let baseUrl = '';
let cookie = '';
let csrf = '';

const post = (body: unknown) => fetch(`${baseUrl}/api/admin/providers`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body),
});

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { getRawDb } = await import('../../src/server/db');
  const { sha256Hex } = await import('../../src/server/auth/ids');
  const session = getRawDb().prepare('SELECT id FROM admin_sessions WHERE token_digest=?').get(sha256Hex(cookie.slice('ld_session='.length))) as { id: string };
  csrf = (getRawDb().prepare('SELECT token FROM csrf_tokens WHERE session_id=?').get(session.id) as { token: string }).token;
});

afterAll(async () => { await app.close(); (await import('../../src/server/db')).closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('one-click account-pool provider creation', () => {
  it('creates a Codex provider from its type alone', async () => {
    const res = await post({ type: 'codex' });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; slug: string };
    expect(body.slug).toBe('codex');
    const { getRawDb } = await import('../../src/server/db');
    const row = getRawDb().prepare('SELECT name,type,base_url,encrypted_api_key FROM providers WHERE id=?').get(body.id);
    expect(row).toEqual({ name: 'Codex', type: 'codex', base_url: 'https://chatgpt.com', encrypted_api_key: null });
  });

  it('rejects a second pool provider of the same type with a naming error', async () => {
    const res = await post({ type: 'codex' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('already in use');
    expect(body.error.message).toContain('codex');
  });

  it('still requires base URL and API key for a compatible provider', async () => {
    const res = await post({ type: 'openai', name: 'OpenAI' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('API key is required');
  });
});
