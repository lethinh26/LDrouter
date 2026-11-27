import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-claude-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
const upstreamKey = 'sk-ant-api-fixture-only';
const origin = 'https://api.anthropic.com';
let app: FastifyInstance;
let cookie = '', csrf = '', providerId = '', modelId = '', secret = '';
const calls: { url: string; headers: Headers; body: Record<string, unknown>; redirect?: RequestRedirect }[] = [];
function admin(method: 'POST' | 'PATCH', route: string, payload: unknown) {
  return app.inject({ method, url: '/api/admin/' + route, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}
function messages(stream = false) {
  return app.inject({ method: 'POST', url: '/v1/messages', headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'context-1m-2025-08-07' }, payload: { model: 'claude-code/fixture-claude', stream, max_tokens: 500, thinking: { type: 'adaptive' }, system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'previous', signature: 'fixture-signature' }, { type: 'text', text: 'Previous answer' }] }, { role: 'user', content: 'Continue' }], tools: [{ name: 'fixture_tool', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] } });
}
beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app'); app = await buildApp();
  const credentials = { username: 'admin', password: 'claude-fixture-password' };
  expect((await app.inject({ method: 'POST', url: '/api/admin/setup', payload: credentials })).statusCode).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: credentials });
  const header = login.headers['set-cookie']; cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0] ?? '';
  csrf = (await app.inject({ method: 'GET', url: '/api/admin/csrf', headers: { cookie } })).json().csrfToken;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(origin + '/')) throw new Error('Unexpected upstream destination');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, headers: new Headers(init?.headers), body, redirect: init?.redirect });
    if (url.includes('/v1/models')) return Response.json(url.includes('after_id') ? { data: [{ id: 'fixture-other', display_name: 'Other' }], has_more: false } : { data: [{ id: 'fixture-claude', display_name: 'Fixture Claude' }], has_more: true, last_id: 'fixture-claude' });
    if (url.endsWith('/count_tokens')) return Response.json({ input_tokens: 31 });
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-claude', content: [{ type: 'text', text: 'Fixture response' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } };
    if (!body.stream) return Response.json(message);
    const events = [{ type: 'message_start', message: { ...message, content: [], usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture response' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = await admin('POST', 'providers', { name: 'Claude Code', slug: 'claude-code', type: 'anthropic', providerKind: 'claude_code', apiKey: upstreamKey });
  expect(provider.statusCode).toBe(200); providerId = provider.json().id;
  expect((await admin('POST', 'models/import', { providerId, modelIds: ['fixture-claude'] })).statusCode).toBe(200);
  const { getRawDb } = await import('../../src/server/db');
  modelId = (getRawDb().prepare('SELECT id FROM models WHERE provider_id=?').get(providerId) as { id: string }).id;
  const key = await admin('POST', 'api-keys', { name: 'Claude fixture', allowAllModels: false, permissions: [{ targetKind: 'model', targetId: modelId }], maxOutputTokensPerRequest: 100 });
  expect(key.statusCode).toBe(200); secret = key.json().secret;
});
beforeEach(() => { calls.length = 0; });
afterAll(async () => { vi.restoreAllMocks(); await app?.close(); (await import('../../src/server/db')).closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('Claude Code API-key integration', () => {
  it('rejects subscription credentials and external destination changes', async () => {
    expect((await admin('POST', 'providers', { name: 'No OAuth', type: 'anthropic', providerKind: 'claude_code', apiKey: 'sk-ant-oat-fixture' })).statusCode).toBe(400);
    expect((await admin('PATCH', 'providers', { id: providerId, baseUrl: 'https://example.test' })).statusCode).toBe(400);
    expect((await admin('PATCH', 'providers', { id: providerId, customHeaders: { authorization: 'Bearer fixture' } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('discovers the actual paginated catalog and rejects unlisted imports', async () => {
    const res = await admin('POST', `providers/${providerId}/discover`, {});
    expect(res.statusCode).toBe(200); expect(res.json().models.map((m: { upstreamId: string }) => m.upstreamId)).toEqual(['fixture-claude', 'fixture-other']);
    expect(calls).toHaveLength(2); expect(calls[1]?.url).toContain('after_id=fixture-claude');
    expect(calls.every(c => c.headers.get('x-api-key') === upstreamKey && c.redirect === 'error')).toBe(true);
    expect((await admin('POST', 'models/import', { providerId, modelIds: ['missing'] })).statusCode).toBe(400);
  });
  it('preserves native Messages fields and enforces the gateway output cap', async () => {
    const res = await messages(); expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'msg_fixture', model: 'claude-code/fixture-claude', stop_sequence: null });
    expect(calls[0]?.body).toMatchObject({ model: 'fixture-claude', max_tokens: 100, thinking: { type: 'adaptive' }, messages: [{ role: 'assistant', content: [{ type: 'thinking', signature: 'fixture-signature' }, { type: 'text', text: 'Previous answer' }] }, { role: 'user', content: 'Continue' }] });
    expect(calls[0]?.body.system).toEqual([{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }]);
    expect(calls[0]?.headers.get('x-api-key')).toBe(upstreamKey); expect(calls[0]?.headers.get('authorization')).toBeNull();
    expect(calls[0]?.headers.get('anthropic-beta')).toBe('context-1m-2025-08-07'); expect(calls[0]?.redirect).toBe('error');
  });
  it('streams native Messages and applies the same cap', async () => {
    const res = await messages(true); expect(res.statusCode).toBe(200); expect(res.body).toContain('message_stop'); expect(res.body).toContain('Fixture response');
    expect(calls[0]?.body).toMatchObject({ max_tokens: 100, stream: true });
  });
  it('uses upstream count_tokens rather than a local estimate for this integration', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/messages/count_tokens', headers: { 'x-api-key': secret }, payload: { model: 'claude-code/fixture-claude', messages: [{ role: 'user', content: 'Hello' }] } });
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual({ input_tokens: 31 }); expect(calls[0]?.url).toBe(origin + '/v1/messages/count_tokens');
    expect(calls[0]?.body.model).toBe('fixture-claude');
  });
});
