import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
let nativeEvents: Record<string, unknown>[] | null = null;
let catalogEntries: Record<string, unknown>[] | null = null;
let modelStatuses: Record<string, number> = {};
let onMockCall: ((url: string) => Promise<void>) | null = null;
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

function completed(output: Record<string, unknown>[]) {
  return { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output, usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } };
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
    await onMockCall?.(url);
    if (url.startsWith(origin + '/models')) return Response.json({ models: catalogEntries ?? [{ slug: 'fixture-model', display_name: 'Fixture', supported_reasoning_levels: ['high'], upgrade: { model: 'hidden' } }, { slug: 'unconfigured' }] });
    const status = modelStatuses[String(calls.at(-1)?.body.model)] ?? nextStatus;
    if (status !== 200) return new Response(authorization, { status, headers: { 'retry-after': '120' } });
    if (nativeEvents) return new Response(sse(nativeEvents), { headers: { 'content-type': 'text/event-stream' } });
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
beforeEach(() => { calls.length = 0; nextStatus = 200; truncated = false; nativeEvents = null; catalogEntries = null; modelStatuses = {}; onMockCall = null; });
afterAll(async () => { vi.restoreAllMocks(); await app?.close(); (await import('../../src/server/db')).closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function issueGatewayOAuth(apiKeyId: string) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const redirectUri = 'http://127.0.0.1:43127/callback';
  const approved = await app.inject({
    method: 'POST', url: '/api/admin/gateway-oauth/authorize',
    headers: { cookie, 'x-csrf-token': csrf, host: '127.0.0.1' },
    payload: { client_id: 'ldrouter-codex', response_type: 'code', redirect_uri: redirectUri,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', state: crypto.randomBytes(32).toString('base64url'), apiKeyId },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  const code = new URL(approved.json().redirectUrl).searchParams.get('code')!;
  const exchanged = await app.inject({
    method: 'POST', url: '/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'ldrouter-codex', code, redirect_uri: redirectUri, code_verifier: verifier }).toString(),
  });
  expect(exchanged.statusCode, exchanged.body).toBe(200);
  return exchanged.json<{ access_token: string; refresh_token: string }>();
}

function oauthResponses(access: string, model = 'coding-alias') {
  return app.inject({ method: 'POST', url: '/backend-api/codex/responses',
    headers: { 'x-gateway-token': 'Bearer ' + access, authorization, 'chatgpt-account-id': 'fixture-account' },
    payload: { model, stream: true, store: false, input: [{ type: 'message', role: 'user', content: 'fixture' }] } });
}

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
  it.each(['responses', 'streaming'])('hides direct models and aliases with disabled %s capability', async (capability) => {
    expect((await admin('PATCH', 'models', { id: modelId, capabilities: { [capability]: false } })).statusCode).toBe(200);
    try {
      const list = await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: { authorization, 'x-api-key': secret } });
      expect(list.statusCode).toBe(200);
      expect(list.json().models).toEqual([]);
      expect((await responses()).statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    } finally {
      expect((await admin('PATCH', 'models', { id: modelId, capabilities: { [capability]: true } })).statusCode).toBe(200);
    }
  });
  it.each([
    { conversation: 'conv_fixture' },
    { input: [{ type: 'item_reference', id: 'msg_fixture' }] },
  ])('rejects server-side conversation references before dispatch', async (extra) => {
    expect((await responses('coding-alias', secret, extra)).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it.each([
    { capability: 'tools', extra: { tools: [{ type: 'function', name: 'fixture_tool', parameters: { type: 'object' } }] } },
    { capability: 'image_input', extra: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'fixture-image' }] }] } },
    { capability: 'audio_input', extra: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'fixture', format: 'wav' } }] }] } },
    { capability: 'structured_output', extra: { text: { format: { type: 'json_schema', name: 'fixture', schema: { type: 'object' } } } } },
  ])('enforces native $capability requirements without altering the body', async ({ capability, extra }) => {
    expect((await admin('PATCH', 'models', { id: modelId, capabilities: { [capability]: false } })).statusCode).toBe(200);
    try {
      expect((await responses('coding-alias', secret, extra)).statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    } finally {
      expect((await admin('PATCH', 'models', { id: modelId, capabilities: { [capability]: capability === 'tools' ? true : null } })).statusCode).toBe(200);
    }
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

  it('rejects a native terminal with only an unknown delta before wire commitment', async () => {
    nativeEvents = [{ type: 'response.unknown.delta', delta: 'fixture-unknown' }, completed([])];
    const res = await responses();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('fixture-unknown');
    expect(res.body).not.toContain('response.completed');
    expect(calls).toHaveLength(1);
    const { getRawDb } = await import('../../src/server/db');
    expect(getRawDb().prepare('SELECT success, partial_stream, ttft_ms, input_tokens, output_tokens FROM requests WHERE id=?').get(res.json().error.request_id)).toEqual({ success: 0, partial_stream: 0, ttft_ms: null, input_tokens: 12, output_tokens: 8 });
  });

  it('rejects a native terminal after a reasoning delta and accounts for the committed failure', async () => {
    nativeEvents = [{ type: 'response.created', response: { id: 'resp_fixture' } }, { type: 'response.reasoning_summary_text.delta', item_id: 'rs_fixture', delta: 'fixture-reasoning' }, completed([{ type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'fixture-reasoning' }] }])];
    const res = await responses();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('rs_fixture');
    expect(res.body).toContain('event: error');
    expect(res.body).not.toContain('response.completed');
    expect(calls).toHaveLength(1);
    const { getRawDb } = await import('../../src/server/db');
    const requestId = res.headers['x-request-id'];
    expect(getRawDb().prepare('SELECT success, partial_stream, ttft_ms, input_tokens, output_tokens, reasoning_tokens, attempts_count FROM requests WHERE id=?').get(requestId)).toEqual({ success: 0, partial_stream: 1, ttft_ms: expect.any(Number), input_tokens: 12, output_tokens: 8, reasoning_tokens: 2, attempts_count: 1 });
    expect(getRawDb().prepare('SELECT success, stream_started, partial_response, input_tokens, output_tokens FROM request_attempts WHERE request_id=?').get(requestId)).toEqual({ success: 0, stream_started: 1, partial_response: 1, input_tokens: 12, output_tokens: 8 });
  });

  it.each([
    { label: 'untyped content', output: { type: 'message', id: 'msg_fixture', content: [{ type: 'unknown', text: 'fixture-not-an-answer' }] } },
    { label: 'blank text', output: { type: 'message', id: 'msg_fixture', content: [{ type: 'output_text', text: ' \n' }] } },
    { label: 'blank refusal', output: { type: 'message', id: 'msg_fixture', content: [{ type: 'refusal', refusal: ' ' }] } },
    { label: 'non-assistant message', output: { type: 'message', role: 'user', status: 'completed', content: [{ type: 'output_text', text: 'fixture-not-an-answer' }] } },
    { label: 'incomplete message', output: { type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'fixture-incomplete' }] } },
    { label: 'missing call ID', output: { type: 'function_call', id: 'fc_fixture', call_id: '', name: 'fixture_tool', arguments: '{}' } },
    { label: 'malformed function arguments', output: { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'fixture_tool', arguments: '{' } },
    { label: 'wrong custom tool input type', output: { type: 'custom_tool_call', id: 'ctc_fixture', call_id: 'call_fixture', name: 'fixture_tool', input: { x: 1 } } },
  ])('rejects a native terminal containing $label', async ({ output }) => {
    nativeEvents = [completed([output])];
    const res = await responses();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('response.completed');
    expect(calls).toHaveLength(1);
  });

  it.each([
    { label: 'text', output: { type: 'message', id: 'msg_fixture', content: [{ type: 'output_text', text: 'fixture-answer' }] } },
    { label: 'refusal', output: { type: 'message', id: 'msg_fixture', content: [{ type: 'refusal', refusal: 'fixture-refusal' }] } },
    { label: 'custom tool call', output: { type: 'custom_tool_call', id: 'ctc_fixture', call_id: 'call_fixture', name: 'fixture_tool', input: 'fixture-tool-input' } },
  ])('preserves native terminal $label and IDs following reasoning', async ({ output }) => {
    nativeEvents = [{ type: 'response.reasoning_summary_text.delta', item_id: 'rs_fixture', delta: 'fixture-reasoning' }, completed([output])];
    const res = await responses();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(sse(nativeEvents));
    expect(calls).toHaveLength(1);
    const { getRawDb } = await import('../../src/server/db');
    expect(getRawDb().prepare('SELECT success, partial_stream, input_tokens, output_tokens FROM requests WHERE id=?').get(res.headers['x-request-id'])).toEqual({ success: 1, partial_stream: 0, input_tokens: 12, output_tokens: 8 });
  });

  it('reports an unsuccessful native terminal safely after actual answer output', async () => {
    nativeEvents = [{ type: 'response.output_text.delta', item_id: 'msg_fixture', delta: 'fixture-answer' }, { type: 'response.failed', response: { id: 'resp_fixture', error: { message: 'fixture-private-upstream-error' }, usage: { input_tokens: 12, output_tokens: 8 } } }];
    const res = await responses();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('fixture-answer');
    expect(res.body).toContain('event: error');
    expect(res.body).not.toContain('fixture-private-upstream-error');
    expect(res.body).not.toContain('response.completed');
    expect(calls).toHaveLength(1);
    const { getRawDb } = await import('../../src/server/db');
    const request = getRawDb().prepare('SELECT success, partial_stream, input_tokens, output_tokens, error_message FROM requests WHERE id=?').get(res.headers['x-request-id']);
    expect(request).toMatchObject({ success: 0, partial_stream: 1, input_tokens: 12, output_tokens: 8 });
    expect(JSON.stringify(request)).not.toContain('fixture-private-upstream-error');
  });
});

describe('native Codex combo', () => {
  let comboName = '', comboSecret = '', comboAlias = '', comboKeyId = '';
  const entries = [
    { slug: 'fixture-model', display_name: 'Fixture A', supported_reasoning_levels: ['high'], context_window: 10000 },
    { slug: 'fixture-fallback', display_name: 'Fixture B', supported_reasoning_levels: ['high'], context_window: 10000 },
  ];
  beforeAll(async () => {
    expect((await admin('POST', 'models/import', { providerId, modelIds: ['fixture-fallback'] })).statusCode).toBe(200);
    const { getRawDb } = await import('../../src/server/db');
    const fallback = getRawDb().prepare('SELECT id FROM models WHERE provider_id=? AND upstream_model_id=?').get(providerId, 'fixture-fallback') as { id: string };
    const combo = await admin('POST', 'combos', { name: 'Native coding', slug: 'native-coding', comboKind: 'codex_native', mode: 'fallback', members: [{ modelId, position: 0 }, { modelId: fallback.id, position: 1 }] });
    expect(combo.statusCode).toBe(200);
    comboName = combo.json().publicModelId;
    const alias = await admin('POST', 'aliases', { alias: 'native-coding-alias', targetKind: 'combo', targetId: combo.json().id });
    expect(alias.statusCode).toBe(200); comboAlias = 'native-coding-alias';
    const key = await admin('POST', 'api-keys', { name: 'Native combo only', allowAllModels: false, permissions: [{ targetKind: 'combo', targetId: combo.json().id }], maxConcurrent: 1 });
    expect(key.statusCode).toBe(200); comboSecret = key.json().secret; comboKeyId = key.json().id;
  });
  beforeEach(() => { catalogEntries = entries.map(e => ({ ...e })); });

  it('advertises only authorized combo and alias in the signed-in account catalog', async () => {
    const list = await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: { authorization, 'x-api-key': comboSecret, 'chatgpt-account-id': 'fixture-account' } });
    expect(list.statusCode).toBe(200);
    expect(list.json().models.map((m: { slug: string }) => m.slug).sort()).toEqual([comboName, comboAlias].sort());
    const generic = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${comboSecret}` } });
    expect(generic.body).not.toContain(comboName); expect(generic.body).not.toContain(comboAlias);
    expect((await responses('codex/fixture-model', comboSecret)).statusCode).toBe(403);
    const denied = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${comboSecret}` }, payload: { model: comboName, messages: [{ role: 'user', content: 'hello' }] } });
    expect(denied.statusCode).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('falls back on pre-output 503 with the exact same client identity and native body', async () => {
    modelStatuses = { 'fixture-model': 503 };
    const result = await responses(comboAlias, comboSecret);
    expect(result.statusCode).toBe(200); expect(result.body).toContain('response.completed');
    expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-model', 'fixture-fallback']);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe(authorization);
      expect(call.headers.get('chatgpt-account-id')).toBe('fixture-account');
      expect(call.headers.has('x-api-key')).toBe(false);
    }
    expect(calls[1]?.body.input).toEqual(calls[2]?.body.input);
    const { getRawDb } = await import('../../src/server/db');
    expect(getRawDb().prepare('SELECT success, attempts_count, input_tokens, output_tokens FROM requests WHERE id=?').get(result.headers['x-request-id'])).toEqual({ success: 1, attempts_count: 2, input_tokens: 12, output_tokens: 8 });
  });

  it.each([401, 403, 429])('stops on upstream %s without fallback', async (status) => {
    modelStatuses = { 'fixture-model': status };
    const result = await responses(comboName, comboSecret);
    expect(result.statusCode).toBe(status);
    expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-model']);
  });

  it('never retries after native output has started', async () => {
    truncated = true;
    const result = await responses(comboName, comboSecret);
    expect(result.statusCode).toBe(200); expect(result.body).not.toContain('response.completed');
    expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-model']);
  });

  it('does not replay a semantic error encoded in a successful HTTP SSE response', async () => {
    nativeEvents = [{ type: 'response.failed', response: { error: { code: 'usage_limit_reached' } } }];
    const result = await responses(comboName, comboSecret);
    expect(result.statusCode).toBe(502);
    expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-model']);
    expect(result.body).not.toContain('usage_limit_reached');
  });

  it('commits a complete native output item before a missing terminal', async () => {
    nativeEvents = [{ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', status: 'completed', id: 'msg_fixture', content: [{ type: 'output_text', text: 'fixture-answer' }] } }];
    const result = await responses(comboName, comboSecret);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('response.output_item.done');
    expect(result.body).toContain('event: error');
    expect(result.body).not.toContain('response.completed');
    expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-model']);
  });

  it('does not dispatch or persist an old request after database re-open during catalog discovery', async () => {
    const { closeDb, openDb, getRawDb } = await import('../../src/server/db');
    const file = getRawDb().name;
    const before = getRawDb().prepare('SELECT COUNT(*) AS n FROM requests').get();
    onMockCall = async (url) => {
      if (!url.includes('/models')) return;
      onMockCall = null;
      closeDb();
      openDb(file);
    };
    const result = await responses(comboName, comboSecret);
    expect(result.statusCode).toBe(409);
    expect(calls.map(c => c.body.model)).toEqual([undefined]);
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual(before);
  });

  it('does not fall back or write into the new DB epoch after an upstream attempt', async () => {
    const { closeDb, openDb, getRawDb } = await import('../../src/server/db');
    const file = getRawDb().name;
    const before = getRawDb().prepare('SELECT COUNT(*) AS n FROM requests').get();
    modelStatuses = { 'fixture-model': 503 };
    onMockCall = async (url) => {
      if (!url.endsWith('/responses')) return;
      onMockCall = null;
      closeDb();
      openDb(file);
    };
    const result = await responses(comboName, comboSecret);
    expect(result.statusCode).toBe(409);
    expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-model']);
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual(before);
  });

  it('blocks a new fallback dispatch when the gateway OAuth grant is revoked during the first attempt', async () => {
    const pair = await issueGatewayOAuth(comboKeyId);
    const { getRawDb } = await import('../../src/server/db');
    const { sha256Hex } = await import('../../src/server/auth/ids');
    const grant = getRawDb().prepare('SELECT id FROM gateway_oauth_grants WHERE access_digest=?').get(sha256Hex(pair.access_token)) as { id: string };
    modelStatuses = { 'fixture-model': 503 };
    onMockCall = async url => {
      if (!url.endsWith('/responses')) return;
      onMockCall = null;
      const revoked = await app.inject({ method: 'DELETE', url: '/api/admin/gateway-oauth/grants/' + grant.id, headers: { cookie, 'x-csrf-token': csrf } });
      expect(revoked.statusCode).toBe(200);
    };
    const result = await oauthResponses(pair.access_token, comboName);
    expect(result.statusCode).toBe(401);
    expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-model']);
  });

  it('does not route a combo with missing or incompatible catalog metadata', async () => {
    catalogEntries = [{ ...entries[0] }, { ...entries[1], context_window: 5000 }];
    const list = await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: { authorization, 'x-api-key': comboSecret } });
    expect(list.json().models).toEqual([]);
    const result = await responses(comboName, comboSecret);
    expect(result.statusCode).toBe(400);
    expect(calls.every(c => c.url.includes('/models'))).toBe(true);
    catalogEntries = [entries[0]!];
    expect((await responses(comboName, comboSecret)).statusCode).toBe(400);
    expect(calls.every(c => c.url.includes('/models'))).toBe(true);
  });

  it('rejects opaque model-bound history and finite caps before catalog dispatch', async () => {
    expect((await responses(comboName, comboSecret, { input: [{ type: 'reasoning', encrypted_content: 'fixture-opaque-history' }] })).statusCode).toBe(400);
    expect((await responses(comboName, cappedSecret)).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('excludes native combo members with explicitly unsupported request capabilities', async () => {
    expect((await admin('PATCH', 'models', { id: modelId, capabilities: { image_input: false } })).statusCode).toBe(200);
    try {
      const result = await responses(comboName, comboSecret, { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'fixture-image' }] }] });
      expect(result.statusCode).toBe(200);
      expect(calls.map(c => c.body.model)).toEqual([undefined, 'fixture-fallback']);
    } finally {
      expect((await admin('PATCH', 'models', { id: modelId, capabilities: { image_input: null } })).statusCode).toBe(200);
    }
  });
});

describe('first-party OAuth access to native Codex only', () => {
  it('uses real issued tokens with the backing key ACL, shared accounting and no upstream disclosure', async () => {
    const pair = await issueGatewayOAuth(keyId);
    const header = { authorization, 'x-gateway-token': 'Bearer ' + pair.access_token };
    const catalog = await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: header });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().models.map((m: { slug: string }) => m.slug)).toEqual(['coding-alias']);
    expect((await oauthResponses(pair.access_token, 'codex/fixture-model')).statusCode).toBe(403);
    expect((await oauthResponses(pair.access_token, compatibleModel)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer ' + pair.access_token } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: { ...header, authorization: 'Bearer ' + pair.access_token } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: { ...header, 'x-api-key': secret } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: { ...header, host: 'gateway.example' }, remoteAddress: '192.0.2.10' })).statusCode).toBe(401);
    const result = await oauthResponses(pair.access_token);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('response.completed');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe(authorization);
      expect(call.headers.has('x-gateway-token')).toBe(false);
      expect(call.headers.has('x-api-key')).toBe(false);
    }
    const { getRawDb } = await import('../../src/server/db');
    expect(getRawDb().prepare('SELECT api_key_id,success,total_tokens FROM requests WHERE id=?').get(result.headers['x-request-id'])).toEqual({ api_key_id: keyId, success: 1, total_tokens: 20 });
  });

  it('fences catalog results after revocation and does not fall back to a static key', async () => {
    const pair = await issueGatewayOAuth(keyId);
    const { getRawDb } = await import('../../src/server/db');
    const { sha256Hex } = await import('../../src/server/auth/ids');
    const grant = getRawDb().prepare('SELECT id FROM gateway_oauth_grants WHERE access_digest=?').get(sha256Hex(pair.access_token)) as { id: string };
    onMockCall = async () => {
      onMockCall = null;
      const revoke = await app.inject({ method: 'DELETE', url: '/api/admin/gateway-oauth/grants/' + grant.id, headers: { cookie, 'x-csrf-token': csrf } });
      expect(revoke.statusCode).toBe(200);
    };
    const header = { authorization, 'x-gateway-token': 'Bearer ' + pair.access_token };
    expect((await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: header })).statusCode).toBe(401);
    expect((await oauthResponses(pair.access_token)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/backend-api/codex/models', headers: { ...header, 'x-api-key': secret } })).statusCode).toBe(401);
    expect(calls).toHaveLength(1);
    expect((await responses()).statusCode).toBe(200);
  });
});
