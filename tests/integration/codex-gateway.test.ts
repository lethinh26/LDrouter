import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
const origin = 'https://chatgpt.com/backend-api/codex';
const authorization = 'Bearer fixture-client-token-never-persist';
let app: FastifyInstance;
let cookie = '', csrf = '', providerId = '', modelId = '', aliasId = '', keyId = '', secret = '', cappedSecret = '';
let compatibleModel = '';
let nextStatus = 200;
let truncated = false;
const calls: { url: string; headers: Headers; body: Record<string, unknown>; redirect?: RequestRedirect }[] = [];

function admin(method: 'POST' | 'PATCH', route: string, payload: unknown) {
  return app.inject({ method, url: '/api/admin/' + route, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}
function responses(model = 'coding-alias', token = secret, extra: Record<string, unknown> = {}, auth = authorization) {
  return app.inject({ method: 'POST', url: '/backend-api/codex/responses', headers: { 'x-api-key': token, authorization: auth, 'chatgpt-account-id': 'fixture-account' }, payload: { model, stream: true, store: false, input: [{ type: 'message', role: 'user', content: 'fixture-private-prompt' }], ...extra } });
}
function sse(events: Record<string, unknown>[]) {
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  const credentials = { username: 'admin', password: 'codex-test-password' };
  expect((await app.inject({ method: 'POST', url: '/api/admin/setup', payload: credentials })).statusCode).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: credentials });
  const header = login.headers['set-cookie'];
  cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0] ?? '';
  csrf = (await app.inject({ method: 'GET', url: '/api/admin/csrf', headers: { cookie } })).json().csrfToken;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(origin + '/')) throw new Error('Unexpected upstream destination');
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')), redirect: init?.redirect });
    if (url.startsWith(origin + '/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', supported_reasoning_levels: ['high'], upgrade: { model: 'hidden' } }, { slug: 'unconfigured' }] });
    if (nextStatus !== 200) return new Response(authorization, { status: nextStatus, headers: { 'retry-after': '120' } });
    const output = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'fixture_tool', arguments: '{"x":1}' };
    const events = [{ type: 'response.created', response: { id: 'resp_fixture' } }, { type: 'response.output_item.added', output_index: 0, item: output }, { type: 'response.function_call_arguments.delta', item_id: 'fc_fixture', delta: '{"x":1}' }];
    if (!truncated) events.push({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [output], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } } as never);
    return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = await admin('POST', 'providers', { name: 'Codex', slug: 'codex', type: 'openai', providerKind: 'codex', authMode: 'client_oauth', cbFailureThreshold: 1 });
  expect(provider.statusCode).toBe(200); providerId = provider.json().id;
  expect((await admin('POST', 'models/import', { providerId, modelIds: ['fixture-model'] })).statusCode).toBe(200);
  const { getRawDb } = await import('../../src/server/db');
  modelId = (getRawDb().prepare('SELECT id FROM models WHERE provider_id=?').get(providerId) as { id: string }).id;
  const alias = await admin('POST', 'aliases', { alias: 'coding-alias', targetKind: 'model', targetId: modelId });
  expect(alias.statusCode).toBe(200); aliasId = alias.json().id;
  const key = await admin('POST', 'api-keys', { name: 'Codex alias only', allowAllModels: false, permissions: [{ targetKind: 'alias', targetId: aliasId }], rpmLimit: 100, maxConcurrent: 1 });
  expect(key.statusCode).toBe(200); keyId = key.json().id; secret = key.json().secret;
  cappedSecret = (await admin('POST', 'api-keys', { name: 'Capped', allowAllModels: true, maxOutputTokensPerRequest: 100 })).json().secret;
  const compatible = await admin('POST', 'providers', { name: 'Compatible', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-api-key' });
  expect(compatible.statusCode).toBe(200);
  expect((await admin('POST', 'models/import', { providerId: compatible.json().id, modelIds: ['fixture-model'] })).statusCode).toBe(200);
  compatibleModel = 'compatible/fixture-model';
});
beforeEach(() => { calls.length = 0; nextStatus = 200; truncated = false; });
afterAll(async () => { vi.restoreAllMocks(); await app?.close(); (await import('../../src/server/db')).closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('native Codex gateway', () => {
  it('keeps client OAuth immutable and separate from compatible providers', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie } })).json().providers;
    expect(list.find((p: { id: string }) => p.id === providerId)).toMatchObject({ providerKind: 'codex', authMode: 'client_oauth', baseUrl: 'https://chatgpt.com' });
    for (const change of [{ apiKey: 'not-allowed' }, { baseUrl: 'https://example.test' }, { authMode: 'api_key' }, { customHeaders: { authorization: 'not-allowed' } }]) {
      expect((await admin('PATCH', 'providers', { id: providerId, ...change })).statusCode).toBe(400);
    }
    expect((await admin('POST', 'combos', { name: 'Forbidden combo', mode: 'fallback', members: [{ modelId, position: 0 }] })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('filters actual upstream catalog by alias ACL and strips gateway credential', async () => {
    const res = await app.inject({ method: 'GET', url: '/backend-api/codex/models?client_version=0.100.0', headers: { authorization, 'x-api-key': secret, 'chatgpt-account-id': 'fixture-account' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([{ slug: 'coding-alias', display_name: 'fixture-model', supported_reasoning_levels: ['high'], upgrade: null }]);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(calls[0]?.headers.get('authorization')).toBe(authorization);
    expect(calls[0]?.headers.get('chatgpt-account-id')).toBe('fixture-account');
    expect(calls[0]?.headers.has('x-api-key')).toBe(false);
    expect(calls[0]?.redirect).toBe('error');
  });
  it('passes native tool events without rewriting IDs and accounts for usage', async () => {
    const res = await responses();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('response.completed'); expect(res.body).toContain('call_fixture');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ model: 'fixture-model', stream: true, store: false });
    expect(calls[0]?.headers.get('authorization')).toBe(authorization);
    expect(calls[0]?.headers.has('x-api-key')).toBe(false);
    const { getRawDb } = await import('../../src/server/db');
    expect(getRawDb().prepare('SELECT sum(total_tokens) AS total FROM usage_monthly WHERE api_key_id=?').get(keyId)).toEqual({ total: 20 });
    const logs = getRawDb().prepare('SELECT * FROM requests WHERE api_key_id=?').all(keyId);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(authorization);
    expect(JSON.stringify(logs)).not.toContain('fixture-private-prompt');
  });
  it('fails closed for missing credential, forbidden model and unsupported caps', async () => {
    expect((await responses('coding-alias', secret, {}, '')).statusCode).toBe(401);
    expect((await responses('codex/fixture-model')).statusCode).toBe(403);
    expect((await responses(compatibleModel, secret)).statusCode).toBe(403);
    expect((await responses('coding-alias', cappedSecret)).json().error.code).toBe('codex_token_cap_unsupported');
    expect((await responses('coding-alias', secret, { max_output_tokens: 50 })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('does not expose OAuth models on the compatible endpoint or forward a dual credential there', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${secret}` } });
    expect(list.statusCode).toBe(200); expect(list.body).not.toContain('coding-alias');
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization, 'x-api-key': secret }, payload: { model: 'coding-alias', messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.statusCode).toBe(401); expect(calls).toHaveLength(0);
  });
  it('preserves upstream auth and rate-limit errors without poisoning other account requests', async () => {
    nextStatus = 401; const denied = await responses(); expect(denied.statusCode).toBe(401); expect(denied.body).not.toContain(authorization);
    nextStatus = 429; expect((await responses()).statusCode).toBe(429);
    nextStatus = 200; expect((await responses()).statusCode).toBe(200);
    expect(calls).toHaveLength(3);
  });
  it('does not invent a completion after a truncated native stream', async () => {
    truncated = true; const res = await responses();
    expect(res.statusCode).toBe(200); expect(res.body).toContain('response.output_item.added'); expect(res.body).not.toContain('response.completed');
    truncated = false; expect((await responses()).statusCode).toBe(200);
  });
});
