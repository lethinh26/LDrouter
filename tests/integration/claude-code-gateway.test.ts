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
let truncateStream = false;
let onCount: (() => void) | null = null;
let countBody: string | null = null;
const calls: { url: string; headers: Headers; body: Record<string, unknown>; redirect?: RequestRedirect }[] = [];
function admin(method: 'POST' | 'PATCH', route: string, payload: unknown) {
  return app.inject({ method, url: '/api/admin/' + route, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}
function messages(stream = false) {
  return app.inject({ method: 'POST', url: '/v1/messages', headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'context-1m-2025-08-07' }, payload: { model: 'claude-code/fixture-claude', stream, max_tokens: 500, thinking: { type: 'adaptive' }, system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'previous', signature: 'fixture-signature' }, { type: 'text', text: 'Previous answer' }] }, { role: 'user', content: 'Continue' }], tools: [{ name: 'fixture_tool', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] } });
}
function countTokens(model = 'claude-code/fixture-claude', token = secret) {
  return app.inject({ method: 'POST', url: '/v1/messages/count_tokens', headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }, payload: { model, messages: [{ role: 'user', content: 'Hello' }] } });
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
    if (url.endsWith('/count_tokens')) {
      onCount?.();
      return countBody === null ? Response.json({ input_tokens: 31 }) : new Response(countBody, { headers: { 'content-type': 'application/json' } });
    }
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-claude', content: [{ type: 'text', text: 'Fixture response' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } };
    if (!body.stream) return Response.json(message);
    const events = [{ type: 'message_start', message: { ...message, content: [], usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture response' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
    return new Response((truncateStream ? events.slice(0, -1) : events).map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = await admin('POST', 'providers', { name: 'Claude Code', slug: 'claude-code', type: 'anthropic', providerKind: 'claude_code', apiKey: upstreamKey });
  expect(provider.statusCode).toBe(200); providerId = provider.json().id;
  expect((await admin('POST', 'models/import', { providerId, modelIds: ['fixture-claude'] })).statusCode).toBe(200);
  const { getRawDb } = await import('../../src/server/db');
  modelId = (getRawDb().prepare('SELECT id FROM models WHERE provider_id=?').get(providerId) as { id: string }).id;
  const key = await admin('POST', 'api-keys', { name: 'Claude fixture', allowAllModels: false, permissions: [{ targetKind: 'model', targetId: modelId }], maxOutputTokensPerRequest: 100, maxConcurrent: 1 });
  expect(key.statusCode).toBe(200); secret = key.json().secret;
});
beforeEach(() => { calls.length = 0; truncateStream = false; onCount = null; countBody = null; });
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
  it('does not synthesize a successful terminal after message_delta when the native stream is truncated', async () => {
    truncateStream = true;
    const res = await messages(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Fixture response');
    expect(res.body).toContain('message_delta');
    expect(res.body).not.toContain('message_stop');
    expect(calls).toHaveLength(1);
    const { getRawDb } = await import('../../src/server/db');
    const requestId = res.headers['x-request-id'];
    expect(getRawDb().prepare('SELECT success, partial_stream, input_tokens, output_tokens, attempts_count FROM requests WHERE id=?').get(requestId)).toEqual({ success: 0, partial_stream: 1, input_tokens: 10, output_tokens: 5, attempts_count: 1 });
    expect(getRawDb().prepare('SELECT success, partial_response FROM request_attempts WHERE request_id=?').get(requestId)).toEqual({ success: 0, partial_response: 1 });
    truncateStream = false;
    const recovered = await messages(true);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body).toContain('message_stop');
  });
  it('uses upstream count_tokens rather than a local estimate for this integration', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/messages/count_tokens', headers: { 'x-api-key': secret }, payload: { model: 'claude-code/fixture-claude', messages: [{ role: 'user', content: 'Hello' }] } });
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual({ input_tokens: 31 }); expect(calls[0]?.url).toBe(origin + '/v1/messages/count_tokens');
    expect(calls[0]?.body.model).toBe('fixture-claude');
  });
});

describe('native count_tokens authorization and response boundary', () => {
  let countSecret = '', countKeyId = '';
  beforeAll(async () => {
    const { getRawDb } = await import('../../src/server/db/index');
    const raw = getRawDb();
    raw.exec(`INSERT INTO providers(id,name,slug,type,base_url) VALUES
      ('count-codex','Count Codex','count-codex','openai','https://chatgpt.com'),
      ('count-compatible','Count compatible','count-compatible','anthropic','https://example.test');
      INSERT INTO provider_integrations VALUES ('count-codex','codex','client_oauth');
      INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES
      ('count-codex-model','count-codex','fixture-codex','count-codex/fixture-codex','Codex'),
      ('count-compatible-model','count-compatible','fixture-compatible','count-compatible/fixture-compatible','Compatible');
      INSERT INTO combos(id,name,slug,public_model_id,mode,combo_kind,fallback_on_429,slow_response_fallback_enabled) VALUES
      ('count-native-combo','Count native','count-native-combo','count-native-combo','fallback','codex_native',0,0),
      ('count-standard-combo','Count standard','count-standard-combo','count-standard-combo','fallback','standard',1,1);
      INSERT INTO combo_members(id,combo_id,model_id,position) VALUES
      ('count-native-member','count-native-combo','count-codex-model',0),
      ('count-standard-member','count-standard-combo','count-compatible-model',0);
      INSERT INTO model_aliases(id,alias,target_kind,target_id) VALUES
      ('count-codex-alias','count-codex-alias','model','count-codex-model'),
      ('count-native-alias','count-native-alias','combo','count-native-combo'),
      ('count-compatible-alias','count-compatible-alias','model','count-compatible-model');`);
    raw.prepare('INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES (?,?,?,?,?)').run('count-claude-alternate', providerId, 'fixture-other', 'claude-code/fixture-other', 'Other');
    raw.prepare('INSERT INTO model_aliases(id,alias,target_kind,target_id) VALUES (?,?,?,?)').run('count-claude-alias', 'count-claude-alias', 'model', modelId);
    const key = await admin('POST', 'api-keys', { name: 'Count boundary fixture', allowAllModels: false, permissions: [{ targetKind: 'model', targetId: modelId }, { targetKind: 'alias', targetId: 'count-claude-alias' }, { targetKind: 'model', targetId: 'count-codex-model' }, { targetKind: 'combo', targetId: 'count-native-combo' }, { targetKind: 'model', targetId: 'count-compatible-model' }, { targetKind: 'combo', targetId: 'count-standard-combo' }], maxConcurrent: 1 });
    expect(key.statusCode).toBe(200);
    countSecret = key.json().secret; countKeyId = key.json().id;
    calls.length = 0;
  });

  it.each(['count-codex/fixture-codex', 'count-codex-alias', 'count-native-combo', 'count-native-alias'])('rejects Codex target %s even when the gateway ACL permits it', async (name) => {
    const res = await countTokens(name, countSecret);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe('authentication_error');
    expect(calls).toHaveLength(0);
  });

  it.each(['count-compatible/fixture-compatible', 'count-compatible-alias', 'count-standard-combo'])('keeps local estimates for %s', async (name) => {
    const res = await countTokens(name, countSecret);
    expect(res.statusCode).toBe(200);
    expect(res.json().input_tokens).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it('denies the initial ACL before any native or compatible count', async () => {
    expect((await countTokens('count-native-combo')).statusCode).toBe(403);
    expect((await countTokens('count-compatible/fixture-compatible')).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects a successful upstream count from a previous database epoch and releases the slot', async () => {
    const { closeDb, openDb, getRawDb } = await import('../../src/server/db/index');
    const file = getRawDb().name;
    const before = getRawDb().prepare('SELECT COUNT(*) AS n FROM requests').get();
    onCount = () => { closeDb(); openDb(file); };
    const res = await countTokens('count-claude-alias', countSecret);
    expect(res.statusCode).toBe(409);
    expect(res.json()).not.toHaveProperty('input_tokens');
    expect(calls).toHaveLength(1);
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual(before);
    onCount = null;
    expect((await countTokens('count-claude-alias', countSecret)).statusCode).toBe(200);
  });

  it.each(['disabled', 'expired', 'changed digest', 'IP denied', 'ACL revoked', 'alias disabled', 'alias retargeted', 'alias renamed', 'model disabled', 'model unavailable', 'upstream model changed', 'provider changed', 'provider disabled', 'provider credential changed'] as const)('rejects a count after %s during upstream I/O and releases the slot', async (change) => {
    const { getRawDb } = await import('../../src/server/db/index');
    const raw = getRawDb();
    let undo: () => void;
    const update = (table: string, column: string, id: string, value: unknown) => {
      const before = (raw.prepare(`SELECT ${column} AS value FROM ${table} WHERE id=?`).get(id) as { value: unknown }).value;
      onCount = () => { raw.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value, id); };
      return () => { raw.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(before, id); };
    };
    switch (change) {
      case 'disabled': undo = update('api_keys', 'enabled', countKeyId, 0); break;
      case 'expired': undo = update('api_keys', 'expires_at', countKeyId, '2000-01-01T00:00:00.000Z'); break;
      case 'changed digest': undo = update('api_keys', 'key_digest', countKeyId, 'unrecognized-fixture-digest'); break;
      case 'IP denied':
        onCount = () => { raw.prepare("INSERT INTO api_key_ip_rules(id,api_key_id,mode,cidr) VALUES ('count-deny',?,'deny','0.0.0.0/0')").run(countKeyId); };
        undo = () => { raw.exec("DELETE FROM api_key_ip_rules WHERE id='count-deny'"); }; break;
      case 'ACL revoked': {
        const perms = raw.prepare('SELECT id, target_kind, target_id FROM api_key_model_permissions WHERE api_key_id=?').all(countKeyId) as { id: string; target_kind: string; target_id: string }[];
        onCount = () => { raw.prepare('DELETE FROM api_key_model_permissions WHERE api_key_id=?').run(countKeyId); };
        undo = () => { for (const p of perms) raw.prepare('INSERT INTO api_key_model_permissions(id,api_key_id,target_kind,target_id) VALUES (?,?,?,?)').run(p.id, countKeyId, p.target_kind, p.target_id); }; break;
      }
      case 'alias disabled': undo = update('model_aliases', 'enabled', 'count-claude-alias', 0); break;
      case 'alias retargeted': undo = update('model_aliases', 'target_id', 'count-claude-alias', 'count-claude-alternate'); break;
      case 'alias renamed': undo = update('model_aliases', 'alias', 'count-claude-alias', 'count-renamed-alias'); break;
      case 'model disabled': undo = update('models', 'enabled', modelId, 0); break;
      case 'model unavailable': undo = update('models', 'upstream_available', modelId, 0); break;
      case 'upstream model changed': undo = update('models', 'upstream_model_id', modelId, 'fixture-changed'); break;
      case 'provider changed': undo = update('models', 'provider_id', modelId, 'count-compatible'); break;
      case 'provider disabled': undo = update('providers', 'enabled', providerId, 0); break;
      case 'provider credential changed': undo = update('providers', 'api_key_nonce', providerId, 'changed-fixture-nonce'); break;
    }
    try {
      const res = await countTokens('count-claude-alias', countSecret);
      expect([403, 409, 503]).toContain(res.statusCode);
      expect(res.json()).not.toHaveProperty('input_tokens');
      expect(calls).toHaveLength(1);
    } finally { onCount = null; undo(); }
    expect((await countTokens('count-claude-alias', countSecret)).statusCode).toBe(200);
  });

  it.each(['{not-json-fixture-private', '{"input_tokens":"fixture-private"}', '{"input_tokens":-1}', '{"input_tokens":1.5}', '{"input_tokens":9007199254740992}', '{}', 'null'])('returns a sanitized 502 for malformed upstream count %s', async (invalid) => {
    countBody = invalid;
    const res = await countTokens();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toEqual({ type: 'upstream_error', message: 'Invalid Claude token count response' });
    expect(res.body).not.toContain('fixture-private');
    expect(calls).toHaveLength(1);
    countBody = null;
    expect((await countTokens()).statusCode).toBe(200);
  });
});
