// Regression: the compatible provider surface is the only provider creation path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-provider-types-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;
let baseUrl: string;
let cookie: string;
let compatibleProviderId: string;

function mutate(method: 'POST' | 'PATCH', body: unknown) {
  return fetch(`${baseUrl}/api/admin/providers`, {
    method, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const credentials = { username: 'admin', password: 'provider-types-test-password' };
  const setup = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
  });
  expect(setup.status).toBe(200);
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
});

afterAll(async () => {
  await app?.close();
  (await import('../../src/server/db')).closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('supported provider API', () => {
  it('creates both compatible types, including a normal provider whose name resembles a retired type', async () => {
    const created = await mutate('POST', { type: 'openai', name: 'Codex relay', slug: 'codex-relay', baseUrl: 'https://example.test', apiKey: 'sk-test-openai' });
    expect(created.status).toBe(200);
    compatibleProviderId = (await created.json() as { id: string }).id;
    const anthropic = await mutate('POST', { type: 'anthropic', name: 'Anthropic relay', slug: 'anthropic-relay', baseUrl: 'https://example.test', apiKey: 'sk-test-anthropic' });
    expect(anthropic.status).toBe(200);
    const list = await fetch(`${baseUrl}/api/admin/providers`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const body = await list.json() as { providers: Array<{ id: string; type: string; slug: string }> };
    expect(body.providers).toHaveLength(2);
    expect(body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: compatibleProviderId, type: 'openai', slug: 'codex-relay' }),
      expect.objectContaining({ type: 'anthropic', slug: 'anthropic-relay' }),
    ]));
    expect(JSON.stringify(body)).not.toContain('sk-test-');
  });

  it.each(['codex', 'qoder'])('rejects retired type %s for create and update without mutating the database', async (type) => {
    const { getRawDb } = await import('../../src/server/db');
    const raw = getRawDb();
    const before = raw.prepare('SELECT id, type, slug FROM providers ORDER BY id').all();
    const create = await mutate('POST', { type, name: 'Unsupported', slug: `unsupported-${type}`, baseUrl: 'https://example.test', apiKey: 'sk-unused' });
    expect(create.status).toBe(400);
    const patch = await mutate('PATCH', { id: compatibleProviderId, type, name: 'Should not change' });
    expect(patch.status).toBe(400);
    expect(raw.prepare('SELECT id, type, slug FROM providers ORDER BY id').all()).toEqual(before);
  });

  it('continues to require an API key and base URL for compatible providers', async () => {
    const res = await mutate('POST', { type: 'openai', name: 'Missing credential' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('API key is required');
  });

  it.each(['/api/admin/codex/accounts', '/api/admin/qoder/accounts'])('does not expose retired API %s', async (route) => {
    expect((await fetch(`${baseUrl}${route}`, { headers: { cookie } })).status).toBe(404);
    expect(app.hasRoute({ method: 'GET', url: route })).toBe(false);
  });

  it('does not register OAuth callback or credential import endpoints', () => {
    expect(app.hasRoute({ method: 'GET', url: '/oauth/codex/callback' })).toBe(false);
    expect(app.hasRoute({ method: 'POST', url: '/api/admin/codex/oauth/start' })).toBe(false);
    expect(app.hasRoute({ method: 'POST', url: '/api/admin/codex/accounts/import' })).toBe(false);
    expect(app.hasRoute({ method: 'POST', url: '/api/admin/qoder/accounts/import' })).toBe(false);
  });
});
