import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-builtins-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
let app: FastifyInstance;
let cookie = '', csrf = '';
const upstreamKeys: string[] = [];
function mutate(method: 'POST' | 'PATCH' | 'DELETE', route: string, payload?: unknown) {
  return app.inject({ method, url: '/api/admin/' + route, headers: { cookie, 'x-csrf-token': csrf, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}
const list = () => app.inject({ method: 'GET', url: '/api/admin/builtin-providers', headers: { cookie } });
const add = (kind: string, payload: unknown) => mutate('POST', 'builtin-providers/' + kind + '/connections', payload);
const importModels = (providerId: string, modelIds: string[]) => mutate('POST', 'models/import', { providerId, modelIds });

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  const credentials = { username: 'admin', password: 'builtin-fixture-password' };
  expect((await app.inject({ method: 'POST', url: '/api/admin/setup', payload: credentials })).statusCode).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: credentials });
  const header = login.headers['set-cookie'];
  cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0] ?? '';
  csrf = (await app.inject({ method: 'GET', url: '/api/admin/csrf', headers: { cookie } })).json().csrfToken;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.anthropic.com') throw new Error('Unexpected fixture destination');
    const key = new Headers(init?.headers).get('x-api-key') ?? '';
    upstreamKeys.push(key);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'fixture-shared' }, { id: 'fixture-other' }], has_more: false });
    if (url.pathname === '/v1/messages') return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-shared', content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
    throw new Error('Unexpected fixture path');
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  (await import('../../src/server/db/index')).closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('fixed built-in provider registry and independent connections', () => {
  it('lists both built-ins without creating providers, requires authentication and reserves slugs', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/builtin-providers' })).statusCode).toBe(401);
    const response = await list();
    expect(response.statusCode).toBe(200);
    expect(response.json().providers).toEqual([
      expect.objectContaining({ kind: 'codex', slug: 'cx', namespaceAvailable: true, connections: [] }),
      expect.objectContaining({ kind: 'claude_code', slug: 'cc', namespaceAvailable: true, connections: [] }),
    ]);
    for (const slug of [' CX ', 'cc', 'builtin-connection-custom']) {
      expect((await mutate('POST', 'providers', { name: 'Collision', slug, type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture' })).statusCode).toBe(409);
    }
  });
  it('preserves legacy conflicting routes and blocks canonical activation without overwriting them', async () => {
    const { getRawDb } = await import('../../src/server/db/index');
    const raw = getRawDb();
    raw.exec("INSERT INTO providers(id,name,slug,type,base_url) VALUES ('old-cx','Existing custom','cx','openai','http://127.0.0.1:1'); INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('old-model','old-cx','fixture','cx/fixture','Fixture')");
    try {
      expect((await list()).json().providers[0]).toMatchObject({ namespaceAvailable: false });
      expect((await add('codex', { name: 'Blocked' })).statusCode).toBe(409);
      const { resolveRequestedModel } = await import('../../src/server/routing/resolver');
      expect(resolveRequestedModel('cx/fixture')).toMatchObject({ modelId: 'old-model' });
    } finally {
      raw.exec("DELETE FROM models WHERE id='old-model'; DELETE FROM providers WHERE id='old-cx'");
    }
  });
  it('creates a single canonical Codex client profile with no stored credential and immutable prefix', async () => {
    expect((await add('codex', { name: 'Invalid', apiKey: 'fixture' })).statusCode).toBe(400);
    const created = await add('codex', { name: 'Local Codex' });
    expect(created.statusCode).toBe(200);
    const { id, slug } = created.json();
    expect(slug).toBe('cx');
    expect((await add('codex', { name: 'Duplicate profile' })).statusCode).toBe(409);
    expect((await importModels(id, ['fixture-codex'])).statusCode).toBe(200);
    const { getRawDb } = await import('../../src/server/db/index');
    const raw = getRawDb();
    expect(raw.prepare('SELECT public_model_id FROM models WHERE provider_id=?').get(id)).toEqual({ public_model_id: 'cx/fixture-codex' });
    expect(raw.prepare('SELECT encrypted_api_key,api_key_nonce FROM providers WHERE id=?').get(id)).toEqual({ encrypted_api_key: null, api_key_nonce: null });
    expect((await mutate('PATCH', 'providers', { id, slug: 'new-prefix' })).statusCode).toBe(409);
  });
  it('manages several Claude API-key connections; pins model, permission and usage to the chosen connection', async () => {
    expect((await add('claude_code', { name: 'Unsupported subscription', apiKey: 'sk-ant-oat-fixture' })).statusCode).toBe(400);
    const a = await add('claude_code', { name: 'First workspace', apiKey: 'sk-ant-api-fixture-a' });
    const b = await add('claude_code', { name: 'Second workspace', apiKey: 'sk-ant-api-fixture-b' });
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const first = a.json().id, second = b.json().id;
    expect(a.json().slug).toBe('cc');
    expect(b.json().slug).toBe('cc');
    expect((await importModels(first, ['fixture-shared'])).statusCode).toBe(200);
    const catalog = await mutate('POST', 'providers/' + second + '/discover', {});
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ upstreamId: 'fixture-shared', boundElsewhere: true, boundConnectionName: 'First workspace' }), expect.objectContaining({ upstreamId: 'fixture-other', boundElsewhere: false })]));
    expect((await importModels(second, ['fixture-shared'])).statusCode).toBe(409);
    expect((await importModels(second, ['fixture-other'])).statusCode).toBe(200);
    const { getRawDb } = await import('../../src/server/db/index');
    const raw = getRawDb();
    const model = raw.prepare("SELECT id,provider_id FROM models WHERE public_model_id='cc/fixture-shared'").get() as { id: string; provider_id: string };
    expect(model.provider_id).toBe(first);
    const key = await mutate('POST', 'api-keys', { name: 'Scoped fixture', allowAllModels: false, permissions: [{ targetKind: 'model', targetId: model.id }] });
    expect(key.statusCode).toBe(200);
    const request = (modelId: string) => app.inject({ method: 'POST', url: '/v1/messages', headers: { 'x-api-key': key.json().secret, 'anthropic-version': '2023-06-01' }, payload: { model: modelId, max_tokens: 50, messages: [{ role: 'user', content: 'fixture' }] } });
    upstreamKeys.length = 0;
    expect((await request('cc/fixture-shared')).statusCode).toBe(200);
    expect(upstreamKeys).toEqual(['sk-ant-api-fixture-a']);
    expect((await request('cc/fixture-other')).statusCode).toBe(403);
    const summary = await list();
    expect(summary.body).not.toContain('sk-ant-api-');
    expect(summary.json().providers[1].connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: first, namespaceMode: 'canonical', usage: { requests: 1, totalTokens: 15 } }), expect.objectContaining({ id: second, namespaceMode: 'canonical' })]));
    const requests = await app.inject({ method: 'GET', url: '/api/admin/requests', headers: { cookie } });
    expect(requests.statusCode).toBe(200);
    expect(requests.body).toContain('"providerSlug":"cc"');
    expect((await mutate('PATCH', 'providers', { id: first, apiKey: 'sk-ant-api-other' })).statusCode).toBe(409);
    expect((await mutate('PATCH', 'providers', { id: first, enabled: false })).statusCode).toBe(200);
    upstreamKeys.length = 0;
    expect((await request('cc/fixture-shared')).statusCode).not.toBe(200);
    expect(upstreamKeys).toEqual([]);
    expect((await mutate('DELETE', 'providers/' + first)).statusCode).toBe(409);
    expect(raw.prepare('SELECT id FROM models WHERE id=?').get(model.id)).toEqual({ id: model.id });
  });
});
