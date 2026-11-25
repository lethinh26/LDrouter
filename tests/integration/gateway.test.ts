// Integration tests: full setup, login, providers, models, API key, gateway request via mock upstream.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';

// Each test uses a unique data dir; we start the server in-process to avoid global state.

const dataDir = path.join(os.tmpdir(), `latedev-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const masterKey = 'a'.repeat(32);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = masterKey;
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

// Mock upstream that the gateway can call.
let mockUpstream: import('http').Server | undefined;
let mockPort = 0;
async function startMockUpstream() {
  const http = await import('node:http');
  const { take } = await import('./_mock-control.js');
  const srv = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const h = take();
      if (!h) { res.statusCode = 500; res.end('no handler'); return; }
      await h(req, res, body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('mock port');
  mockPort = addr.port;
  mockUpstream = srv;
}

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let csrfCookies = '';
let apiKey: { id: string; secret: string } | undefined;

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await startMockUpstream();
  // initial setup
  await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  }).then((r) => { if (!r.ok) throw new Error(`setup ${r.status}`); });
  // login
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  if (!loginRes.ok) throw new Error(`login ${loginRes.status}`);
  csrfCookies = loginRes.headers.get('set-cookie') ?? '';
  // provider pointing at mock upstream
  const provRes = await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: csrfCookies },
    body: JSON.stringify({
      name: 'mock', slug: 'mock', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'sk-mock', enabled: true, totalTimeoutMs: 5000, firstTokenTimeoutMs: 5000,
    }),
  });
  if (!provRes.ok) throw new Error(`provider ${provRes.status} ${await provRes.text()}`);
  // import a model manually (skip discovery since mock is OpenAI-compatible with /v1/models)
  const db = (await import('../../src/server/db/index')).getDb();
  const { uuid } = await import('../../src/server/auth/ids');
  const providers = db.select().from((await import('../../src/server/db/schema')).providers).all();
  const provider = providers.find((p) => p.slug === 'mock')!;
  db.insert((await import('../../src/server/db/schema')).models).values({
    id: uuid(), providerId: provider.id, upstreamModelId: 'gpt-mock',
    publicModelId: 'mock/gpt-mock', displayName: 'GPT Mock', enabled: true, upstreamAvailable: true,
    capabilitiesJson: JSON.stringify({ chat: true, streaming: true, tools: true, reasoning: true }),
  }).run();
  // create API key
  const keyRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: csrfCookies },
    body: JSON.stringify({ name: 'test', allowAllModels: true }),
  });
  if (!keyRes.ok) throw new Error(`key ${keyRes.status}`);
  apiKey = (await keyRes.json()) as { id: string; secret: string };
});

afterAll(async () => {
  if (app) await app.close();
  if (mockUpstream) await new Promise<void>((r) => mockUpstream!.close(() => r()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  // Reset circuit breaker state between tests
  const { recordSuccess } = await import('../../src/server/routing/circuit');
  const { getDb, schema } = await import('../../src/server/db/index');
  for (const provider of getDb().select({ id: schema.providers.id }).from(schema.providers).all()) recordSuccess(provider.id);
});

describe('gateway smoke', () => {
  it.each([
    ['chat/completions', false], ['chat/completions', true],
    ['messages', false], ['messages', true],
  ] as const)('%s normalizes send_message schema integers (stream=%s)', async (endpoint, stream) => {
    const { reset, pushHandler } = await import('./_mock-control.js');
    reset();
    const parameters = {
      type: 'object',
      properties: { recipients: { type: 'array', minItems: '1', items: { type: 'string', minLength: '1', enum: ['1'] } } },
    };
    let upstreamBody: Record<string, unknown> | undefined;
    pushHandler((_req, res, body) => {
      const parsed = JSON.parse(body);
      upstreamBody = parsed;
      if (parsed.tools[0].function.parameters.properties.recipients.minItems !== 1) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'Invalid schema for function send_message: "1" is not of type integer' } }));
        return;
      }
      res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json');
      if (stream) {
        res.end('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
      } else {
        res.end(JSON.stringify({
          id: 'cmpl-schema', object: 'chat.completion', created: 0, model: 'gpt-mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }));
      }
    });
    const response = await fetch(`${baseUrl}/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({
        model: 'mock/gpt-mock', stream, max_tokens: 128, messages: [{ role: 'user', content: 'hi' }],
        tools: endpoint === 'messages'
          ? [{ name: 'send_message', input_schema: parameters }]
          : [{ type: 'function', function: { name: 'send_message', parameters } }],
      }),
    });
    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    expect(responseBody).toContain('hello');
    expect(upstreamBody).toMatchObject({
      tools: [{ type: 'function', function: { name: 'send_message', parameters: {
        properties: { recipients: { minItems: 1, items: { minLength: 1, enum: ['1'] } } },
      } } }],
    });
  });

  it.each(['chat/completions', 'messages'])('%s rejects unsafe schema integers before calling upstream', async (endpoint) => {
    const { reset, callCount } = await import('./_mock-control.js');
    reset();
    const parameters = { type: 'array', minItems: '9007199254740993', items: { type: 'string' } };
    const response = await fetch(`${baseUrl}/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({
        model: 'mock/gpt-mock', max_tokens: 128, messages: [{ role: 'user', content: 'hi' }],
        tools: endpoint === 'messages'
          ? [{ name: 'send_message', input_schema: parameters }]
          : [{ type: 'function', function: { name: 'send_message', parameters } }],
      }),
    });
    expect(response.status).toBe(400);
    const responseBody = await response.json();
    expect(responseBody.error).toMatchObject({ type: 'invalid_request_error', message: expect.stringContaining('minItems') });
    expect(JSON.stringify(responseBody)).not.toContain('9007199254740993');
    expect(callCount()).toBe(0);
  });

  it.each([
    ['chat/completions', false, 'xhigh'], ['chat/completions', true, 'xhigh'],
    ['responses', false, 'xhigh'], ['responses', true, 'xhigh'],
    ['chat/completions', false, 'max'], ['chat/completions', true, 'max'],
    ['responses', false, 'max'], ['responses', true, 'max'],
  ] as const)('%s forwards reasoning unchanged (stream=%s, effort=%s)', async (endpoint, stream, effort) => {
    const { reset, pushHandler } = await import('./_mock-control.js');
    reset();
    let upstreamBody: Record<string, unknown> | undefined;
    pushHandler((_req, res, body) => {
      upstreamBody = JSON.parse(body);
      res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json');
      if (stream) {
        res.end('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
      } else {
        res.end(JSON.stringify({
          id: 'cmpl-reasoning', object: 'chat.completion', created: 0, model: 'gpt-mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }));
      }
    });
    const response = await fetch(`${baseUrl}/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({
        model: 'mock/gpt-mock', stream,
        ...(endpoint === 'responses'
          ? { input: 'hi', reasoning: { effort } }
          : { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: effort }),
      }),
    });
    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    expect(responseBody).toContain('hello');
    expect(upstreamBody).toMatchObject({ model: 'gpt-mock', stream, reasoning_effort: effort });
  });

  it.each(['chat/completions', 'responses'])('%s rejects invalid reasoning effort before calling upstream', async (endpoint) => {
    const { reset, callCount } = await import('./_mock-control.js');
    reset();
    const response = await fetch(`${baseUrl}/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({
        model: 'mock/gpt-mock',
        ...(endpoint === 'responses'
          ? { input: 'hi', reasoning: { effort: 'invalid' } }
          : { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'invalid' }),
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe('invalid_request_error');
    expect(callCount()).toBe(0);
  });

  it('GET /v1/models returns the imported model', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${apiKey!.secret}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.some((m: { id: string }) => m.id === 'mock/gpt-mock')).toBe(true);
  });

  it('GET /v1/models lists enabled combos and aliases; hides memberless combos', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const { uuid } = await import('../../src/server/auth/ids');
    const model = db.select().from(sch.models).all().find((m) => m.publicModelId === 'mock/gpt-mock')!;
    const comboId = uuid();
    db.insert(sch.combos).values({ id: comboId, name: 'sol-combo', slug: 'sol-combo', publicModelId: 'combo/sol-combo', mode: 'fallback', enabled: true }).run();
    db.insert(sch.comboMembers).values({ id: uuid(), comboId, modelId: model.id, position: 0, enabled: true }).run();
    db.insert(sch.modelAliases).values({ id: uuid(), alias: 'my-alias', targetKind: 'combo', targetId: comboId, enabled: true }).run();
    // A combo with no members can never route — must not be advertised.
    db.insert(sch.combos).values({ id: uuid(), name: 'empty-combo', slug: 'empty-combo', publicModelId: 'combo/empty-combo', mode: 'fallback', enabled: true }).run();

    const res = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${apiKey!.secret}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((m: { id: string }) => m.id) as string[];
    expect(ids).toContain('mock/gpt-mock');
    expect(ids).toContain('combo/sol-combo');
    expect(ids).toContain('my-alias');
    expect(ids).not.toContain('combo/empty-combo');
  });

  it('combo without slug keeps the name as its model ID (no "combo/" prefix)', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const model = db.select().from(sch.models).all().find((m) => m.publicModelId === 'mock/gpt-mock')!;

    const create = async (payload: object) =>
      fetch(`${baseUrl}/api/admin/combos`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: csrfCookies },
        body: JSON.stringify({ mode: 'fallback', members: [{ modelId: model.id, position: 0, enabled: true }], ...payload }),
      });

    // No slug → public id is the normalized name, dots preserved.
    const noSlug = await create({ name: 'gpt-5.5' });
    expect(noSlug.status).toBe(200);
    expect((await noSlug.json()).publicModelId).toBe('gpt-5.5');

    // Explicit slug → "combo/" prefix.
    const withSlug = await create({ name: 'another', slug: 'sol' });
    expect(withSlug.status).toBe(200);
    expect((await withSlug.json()).publicModelId).toBe('combo/sol');

    // Duplicate id rejected (clashes with the first combo).
    const dup = await create({ name: 'gpt-5.5' });
    expect(dup.status).toBe(400);

    // Listed and routable under the plain name.
    const list = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${apiKey!.secret}` } });
    const ids = ((await list.json()).data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('combo/sol');

    const { reset, pushHandler } = (await import('./_mock-control.js'));
    reset();
    pushHandler((_req: unknown, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: string) => {
      expect(JSON.parse(body).model).toBe('gpt-mock');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'cmpl-1', object: 'chat.completion', created: 0, model: 'gpt-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'via combo' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    });
    const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(chat.status).toBe(200);
    expect((await chat.json()).choices[0].message.content).toBe('via combo');
  });

  it("admin combo test reports the selected upstream model", async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const model = db.select().from(sch.models).all().find((m) => m.publicModelId === 'mock/gpt-mock')!;
    const created = await (await fetch(baseUrl + '/api/admin/combos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: csrfCookies },
      body: JSON.stringify({ name: 'combo-test', slug: 'combo-test', mode: 'fallback', members: [{ modelId: model.id, position: 0, enabled: true }] }),
    })).json() as { id: string };
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    reset();
    pushHandler((_req: unknown, res: { statusCode: number; setHeader: (key: string, value: string) => void; end: (body: string) => void }, body: string) => {
      expect(JSON.parse(body).model).toBe('gpt-mock');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'combo test ok' }, finish_reason: 'stop' }] }));
    });
    const tested = await fetch(baseUrl + '/api/admin/combos/' + created.id + '/test', { method: 'POST', headers: { cookie: csrfCookies } });
    expect(tested.status).toBe(200);
    const result = await tested.json() as { success: boolean; selectedModel: { publicModelId: string; upstreamModelId: string }; attempts: unknown[] };
    expect(result.success).toBe(true);
    expect(result.selectedModel).toMatchObject({ publicModelId: 'mock/gpt-mock', upstreamModelId: 'gpt-mock' });
    expect(result.attempts).toHaveLength(1);
  });

  it('GET /api/admin/stats returns summary, series and top tables', async () => {
    const res = await fetch(`${baseUrl}/api/admin/stats?preset=7d`, { headers: { cookie: csrfCookies } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.totalRequests).toBeGreaterThan(0);
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.topModels.some((m: { publicId: string }) => m.publicId === 'mock/gpt-mock')).toBe(true);
    // v1.9.0: routing dashboard additions
    expect(body.previous).toBeDefined();
    expect(typeof body.previous.totalRequests).toBe('number');
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent[0]).toHaveProperty('providerId');
    expect(body.recent[0]).toHaveProperty('providerName');
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers[0]).toHaveProperty('health');
    expect(body.providers[0]).toHaveProperty('modelCount');
  });

  it('contentLogMode controls whether request/response payloads are persisted', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    const setMode = async (mode: string) => {
      const res = await fetch(`${baseUrl}/api/admin/settings`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', cookie: csrfCookies },
        body: JSON.stringify({ contentLogMode: mode }),
      });
      expect(res.status).toBe(200);
    };
    const chat = async (marker: string) => {
      reset();
      pushHandler((_req: unknown, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'cmpl-c', object: 'chat.completion', created: 0, model: 'gpt-mock',
          choices: [{ index: 0, message: { role: 'assistant', content: `echo-${marker}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
        body: JSON.stringify({ model: 'mock/gpt-mock', messages: [{ role: 'user', content: marker }] }),
      });
      expect(res.status).toBe(200);
    };
    // The newest request row is ours: tests in this file run sequentially.
    const detailOfLatest = async () => {
      const list = await fetch(`${baseUrl}/api/admin/requests?limit=1`, { headers: { cookie: csrfCookies } });
      expect(list.status).toBe(200);
      const rows = (await list.json()).requests as Array<{ id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      const d = await fetch(`${baseUrl}/api/admin/requests/${rows[0]!.id}`, { headers: { cookie: csrfCookies } });
      expect(d.status).toBe(200);
      return await d.json();
    };

    // 1) prompt mode: request payload saved (with prompt text), response NOT saved.
    await setMode('prompt');
    await chat('marker-prompt-mode');
    const promptDetail = await detailOfLatest();
    expect(promptDetail.request.requestPayload).toContain('marker-prompt-mode');
    expect(promptDetail.request.responsePayload).toBeNull();

    // 2) prompt_and_response mode: both saved.
    await setMode('prompt_and_response');
    await chat('marker-full-mode');
    const fullDetail = await detailOfLatest();
    expect(fullDetail.request.requestPayload).toContain('marker-full-mode');
    expect(fullDetail.request.responsePayload).toContain('echo-marker-full-mode');

    // 3) metadata mode (default): neither saved.
    await setMode('metadata');
    await chat('marker-metadata-mode');
    const metaDetail = await detailOfLatest();
    expect(metaDetail.request.requestPayload).toBeNull();
    expect(metaDetail.request.responsePayload).toBeNull();
      expect(metaDetail.request.reproductionCurl).toContain('ld-REPLACE_WITH_KEY');
      expect(metaDetail.request.finalModelUpstreamId).toBe('gpt-mock');
      expect(metaDetail.request.providerName).toBeTruthy();

    // restore default
    await setMode('metadata');
  });

  it('POST /api/admin/models/:id/test-stream streams SSE tokens and delivers test_meta', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const model = db.select().from(sch.models).all().find((m) => m.publicModelId === 'mock/gpt-mock')!;
    reset();
    // Mock upstream returns an SSE stream with 2 content chunks, then usage
    pushHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Xin"},"finish_reason":null}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"index":0,"delta":{"content":" chao"},"finish_reason":null}]}\n\n');
        setTimeout(() => {
          res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }, 10);
      }, 10);
    });
    // Read the SSE stream from the test-stream endpoint
    const res = await globalThis.fetch(`${baseUrl}/api/admin/models/${model.id}/test-stream`, {
      method: 'POST',
      headers: { cookie: csrfCookies },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    // Must contain content deltas
    expect(text).toContain('"content":"Xin"');
    expect(text).toContain('"content":" chao"');
    // Must end with test_meta carrying success + usage
    expect(text).toContain('event: test_meta');
    expect(text).toContain('"success":true');
    expect(text).toContain('"usage"');
  });

  it('GET /api/admin/update/check never 500s (registry unreachable or unpublished package)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/update/check?force=1`, { headers: { cookie: csrfCookies } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentVersion).toBeTypeOf('string');
    expect(typeof body.hasUpdate).toBe('boolean');
    expect(body.status).toHaveProperty('available');
  });

  it('rejects invalid keys', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ld-bogus' },
      body: JSON.stringify({ model: 'mock/gpt-mock', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('custom key WITHOUT ld- prefix authenticates successfully', async () => {
    const customSecret = 'my-custom-key-without-prefix-123456';
    const createRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: csrfCookies },
      body: JSON.stringify({ name: 'custom-no-prefix', allowAllModels: true, secret: customSecret }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { secret: string };
    expect(created.secret).toBe(customSecret);
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${customSecret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain('mock/gpt-mock');
  });

  it('custom key WITHOUT ld- prefix works via x-api-key header (Anthropic style)', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'x-api-key': 'my-custom-key-without-prefix-123456' },
    });
    expect(res.status).toBe(200);
  });

  it('custom key WITHOUT ld- prefix can call chat completions', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    reset();
    pushHandler((_req: unknown, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: string) => {
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe('gpt-mock');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'cmpl-custom', object: 'chat.completion', created: 0, model: 'gpt-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer my-custom-key-without-prefix-123456' },
      body: JSON.stringify({ model: 'mock/gpt-mock', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('chat completions: non-streaming success', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    reset();
    pushHandler((_req: unknown, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: string) => {
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe('gpt-mock');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'cmpl-1', object: 'chat.completion', created: 0, model: 'gpt-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: 'mock/gpt-mock', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('hello');
  });

  it('combo forwards the selected model upstream ID', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const modelId = uuid();
    const comboId = uuid();
    db.insert(schema.models).values({
      id: modelId,
      providerId: provider.id,
      upstreamModelId: 'test/gpt-5.5',
      publicModelId: 'test/gpt-5.5',
      displayName: 'Test GPT-5.5',
      enabled: true,
      upstreamAvailable: true,
      capabilitiesJson: JSON.stringify({ chat: true }),
    }).run();
    db.insert(schema.combos).values({
      id: comboId,
      name: 'upstream-id-regression',
      slug: 'upstream-id-regression',
      publicModelId: 'combo/upstream-id-regression',
      mode: 'fallback',
    }).run();
    db.insert(schema.comboMembers).values({ id: uuid(), comboId, modelId, position: 0, enabled: true }).run();

    let seenModel = '';
    reset();
    pushHandler((_req, res, body) => {
      seenModel = (JSON.parse(body) as { model: string }).model;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'combo-ok' }, finish_reason: 'stop' }] }));
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: 'combo/upstream-id-regression', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(seenModel).toBe('test/gpt-5.5');
  });

  it('demotes repeated slow responses, serves a reserve on failure, and confirms failback with two successful probes', async () => {
    const { reset, pushHandler } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const slowModelId = uuid();
    const fastModelId = uuid();
    const comboId = uuid();
    db.insert(schema.models).values({ id: slowModelId, providerId: provider.id, upstreamModelId: 'slow-model', publicModelId: `mock/slow-${slowModelId}`, displayName: 'Slow model', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true }) }).run();
    db.insert(schema.models).values({ id: fastModelId, providerId: provider.id, upstreamModelId: 'fast-model', publicModelId: `mock/fast-${fastModelId}`, displayName: 'Fast model', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true }) }).run();
    db.insert(schema.combos).values({
      id: comboId, name: 'slow-response-non-stream', slug: `slow-response-non-stream-${comboId}`,
      publicModelId: `combo/slow-response-non-stream-${comboId}`, mode: 'fallback', maxTotalAttempts: 2,
      slowResponseFallbackEnabled: true, slowResponseThresholdSeconds: 1, slowResponseMaxCount: 3,
    }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: slowModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: fastModelId, position: 1, enabled: true },
    ]).run();

    let backupFails = false;
    let primarySlow = true;
    const invoke = async (expected: string) => {
      const seenModels: string[] = [];
      reset();
      pushHandler(async (_req, res, body) => {
        const model = (JSON.parse(body) as { model: string }).model;
        seenModels.push(model);
        if (model === 'slow-model' && primarySlow) await new Promise((resolve) => setTimeout(resolve, 1300));
        if (model === 'fast-model' && backupFails) {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'model_unavailable' } }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: model }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
        body: JSON.stringify({ model: `combo/slow-response-non-stream-${comboId}`, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).toBe(expected);
      return seenModels;
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(invoke('fast-model')).resolves.toEqual(['slow-model', 'fast-model']);
    }
    const { listAdaptiveStates } = await import('../../src/server/routing/combo-adaptive-state');
    const state = () => listAdaptiveStates(comboId).find((row) => row.modelId === slowModelId);
    expect(state()).toMatchObject({ consecutiveSlowCount: 3, lastOutcome: 'soft_timeout', degraded: 'absolute', samples: [] });
    expect(state()?.probeDueMs).toBeGreaterThan(Date.now());
    await expect(invoke('fast-model')).resolves.toEqual(['fast-model']);

    // A is still eligible while degraded; B's model-scoped error must not
    // block A even though they use the same provider. A may exceed the soft limit.
    backupFails = true;
    await expect(invoke('slow-model')).resolves.toEqual(['fast-model', 'slow-model']);
    expect(state()?.degraded).toBe('absolute');
    backupFails = false;
    primarySlow = false;
    const makeProbeDue = () => db.update(schema.comboAdaptiveStates)
      .set({ probeDueMs: Date.now() - 1 }).where(eq(schema.comboAdaptiveStates.modelId, slowModelId)).run();
    makeProbeDue();
    await expect(invoke('slow-model')).resolves.toEqual(['slow-model']);
    expect(state()).toMatchObject({ degraded: 'absolute', recoverySuccesses: 1 });
    await expect(invoke('fast-model')).resolves.toEqual(['fast-model']);
    makeProbeDue();
    await expect(invoke('slow-model')).resolves.toEqual(['slow-model']);
    expect(state()).toMatchObject({ degraded: null, recoverySuccesses: 0 });
    await expect(invoke('slow-model')).resolves.toEqual(['slow-model']);
  }, 15_000);

  it.each([2, 3])('allows one soft-timeout rescue replay only within an actual attempt cap of %s', async (cap) => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const a = uuid();
    const b = uuid();
    const comboId = uuid();
    const modelName = `combo/replay-${comboId}`;
    db.insert(schema.models).values([
      { id: a, providerId: provider.id, upstreamModelId: `replay-a-${cap}`, publicModelId: `mock/replay-a-${cap}`, displayName: 'Replay A' },
      { id: b, providerId: provider.id, upstreamModelId: `replay-b-${cap}`, publicModelId: `mock/replay-b-${cap}`, displayName: 'Replay B' },
    ]).run();
    db.insert(schema.combos).values({ id: comboId, name: 'Replay cap', slug: `replay-${comboId}`, publicModelId: modelName, mode: 'fallback', maxTotalAttempts: cap, slowResponseFallbackEnabled: true, slowResponseThresholdSeconds: 1 }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: a, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: b, position: 1, enabled: true },
    ]).run();
    reset();
    const seen: string[] = [];
    pushHandler((_req, res, body) => {
      const model = (JSON.parse(body) as { model: string }).model;
      seen.push(model);
      if (model === `replay-b-${cap}`) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"model_unavailable"}}');
        return;
      }
      // The first call is censored by the soft watchdog, the replay can run
      // past that threshold but still within the provider hard timeout.
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'rescued' }, finish_reason: 'stop' }] }));
      }, 1200);
      res.on('close', () => clearTimeout(timer));
    });
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(cap === 3 ? 200 : 502);
    const body = await response.json();
    if (cap === 3) expect(body.choices[0].message.content).toBe('rescued');
    expect(seen).toEqual(cap === 3 ? [`replay-a-${cap}`, `replay-b-${cap}`, `replay-a-${cap}`] : [`replay-a-${cap}`, `replay-b-${cap}`]);
    expect(callCount()).toBe(cap);
    const request = db.select().from(schema.requests).all().find((r) => r.requestedModel === modelName)!;
    expect(request).toMatchObject({ success: cap === 3, attemptsCount: cap });
    const attempts = db.select().from(schema.requestAttempts).where(eq(schema.requestAttempts.requestId, request.id)).all().sort((x, y) => x.attemptNumber - y.attemptNumber);
    expect(attempts.map((r) => r.modelId)).toEqual(cap === 3 ? [a, b, a] : [a, b]);
    expect(attempts[0]?.failureReason).toBe('slow_response_timeout');
    if (cap === 3) expect(attempts[2]).toMatchObject({ success: true, selectionReason: 'rescue_replay' });
  }, 10_000);

  it.each(['single-member', 'cap-one', 'all-slow'] as const)('lets the last viable or known-slow candidate complete: %s', async (scenario) => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const { loadCombo, selectCandidates } = await import('../../src/server/routing/combo');
    const { deriveRequiredCapabilities } = await import('../../src/server/routing/capabilities');
    const { classifyWorkload } = await import('../../src/server/routing/combo-policy');
    const { recordAdaptiveOutcome } = await import('../../src/server/routing/combo-adaptive-state');
    const db = getDb();
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const comboId = uuid();
    const modelName = `combo/viable-${comboId}`;
    const modelIds = Array.from({ length: scenario === 'single-member' ? 1 : 2 }, () => uuid());
    const modelRows = modelIds.map((id, index) => ({ id, providerId: provider.id, upstreamModelId: `viable-${scenario}-${index}`, publicModelId: `mock/viable-${scenario}-${index}`, displayName: 'Viable' }));
    db.insert(schema.models).values(modelRows).run();
    db.insert(schema.combos).values({ id: comboId, name: 'Viable', slug: `viable-${comboId}`, publicModelId: modelName, mode: 'fallback', maxTotalAttempts: scenario === 'cap-one' ? 1 : 3, slowResponseFallbackEnabled: true, slowResponseThresholdSeconds: 1 }).run();
    db.insert(schema.comboMembers).values(modelIds.map((modelId, position) => ({ id: uuid(), comboId, modelId, position, enabled: true }))).run();
    if (scenario === 'all-slow') {
      const canonical = { model: modelName, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], stream: false };
      const plan = loadCombo(comboId)!;
      const workload = classifyWorkload(canonical);
      const candidates = selectCandidates(plan, modelRows.map((m) => ({
        modelId: m.id, providerId: m.providerId, publicModelId: m.publicModelId, upstreamModelId: m.upstreamModelId,
        enabled: true, upstreamAvailable: true, circuitOpen: false, providerEnabled: true, capabilities: { chat: true },
      })), deriveRequiredCapabilities(canonical));
      const now = Date.now();
      for (const candidate of candidates) for (let i = 0; i < 3; i++) {
        recordAdaptiveOutcome({ plan, candidate, workload, startedAtMs: now - 20 + i, now: now - 10 + i, kind: 'soft_timeout', latencyMs: 1000, role: 'normal', comparableCandidates: candidates, learn: true });
      }
    }
    reset();
    const seen: string[] = [];
    pushHandler((_req, res, body) => {
      seen.push((JSON.parse(body) as { model: string }).model);
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"choices":[{"message":{"role":"assistant","content":"complete"},"finish_reason":"stop"}]}');
      }, 1200);
      res.on('close', () => clearTimeout(timer));
    });
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('complete');
    expect(callCount()).toBe(1);
    expect(seen).toEqual([modelRows[0]!.upstreamModelId]);
  }, 10_000);

  it('rechecks hard eligibility after a failure and does not spend an attempt on a disabled member', async () => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const comboId = uuid();
    const modelName = `combo/refresh-${comboId}`;
    const ids = [uuid(), uuid(), uuid()];
    db.insert(schema.models).values(ids.map((id, index) => ({
      id, providerId: provider.id, upstreamModelId: `refresh-${index}`, publicModelId: `mock/refresh-${index}`, displayName: 'Refresh',
    }))).run();
    db.insert(schema.combos).values({ id: comboId, name: 'Refresh', slug: `refresh-${comboId}`, publicModelId: modelName, mode: 'fallback', maxTotalAttempts: 2 }).run();
    db.insert(schema.comboMembers).values(ids.map((modelId, position) => ({ id: uuid(), comboId, modelId, position, enabled: true }))).run();
    reset();
    const seen: string[] = [];
    pushHandler((_req, res, body) => {
      const model = (JSON.parse(body) as { model: string }).model;
      seen.push(model);
      if (model === 'refresh-0') {
        db.update(schema.models).set({ enabled: false }).where(eq(schema.models.id, ids[1]!)).run();
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"model_unavailable"}}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"choices":[{"message":{"role":"assistant","content":"third"},"finish_reason":"stop"}]}');
      }
    });
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('third');
    expect(seen).toEqual(['refresh-0', 'refresh-2']);
    expect(callCount()).toBe(2);
    const request = db.select().from(schema.requests).all().find((r) => r.requestedModel === modelName)!;
    expect(request.attemptsCount).toBe(2);
  });

  it.each(['overall-deadline', 'client-disconnect'] as const)('cancels a non-streaming upstream without fallback: %s', async (scenario) => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const { listAdaptiveStates } = await import('../../src/server/routing/combo-adaptive-state');
    const db = getDb();
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const comboId = uuid();
    const modelName = `combo/cancel-${comboId}`;
    const ids = [uuid(), uuid()];
    db.insert(schema.models).values(ids.map((id, index) => ({
      id, providerId: provider.id, upstreamModelId: `cancel-${scenario}-${index}`, publicModelId: `mock/cancel-${scenario}-${index}`, displayName: 'Cancel',
    }))).run();
    db.insert(schema.combos).values({
      id: comboId, name: 'Cancel', slug: `cancel-${comboId}`, publicModelId: modelName, mode: 'fallback', maxTotalAttempts: 2,
      slowResponseThresholdSeconds: 2, maxRequestDurationSeconds: scenario === 'overall-deadline' ? 1 : null,
    }).run();
    db.insert(schema.comboMembers).values(ids.map((modelId, position) => ({ id: uuid(), comboId, modelId, position, enabled: true }))).run();
    reset();
    let upstreamClosed = false;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    pushHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.on('close', () => { upstreamClosed = true; });
      notifyStarted();
    });
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    });
    if (scenario === 'client-disconnect') {
      const rejected = expect(pending).rejects.toThrow();
      await started;
      controller.abort();
      await rejected;
    } else {
      const response = await pending;
      expect(response.status).toBe(504);
      expect((await response.json()).error.code).toBe('combo_overall_timeout');
    }
    let request: typeof schema.requests.$inferSelect | undefined;
    for (let i = 0; i < 60; i++) {
      request = db.select().from(schema.requests).all().find((r) => r.requestedModel === modelName);
      if (upstreamClosed && request) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(upstreamClosed).toBe(true);
    expect(callCount()).toBe(1);
    expect(request).toMatchObject({ success: false, attemptsCount: 1, httpStatus: scenario === 'overall-deadline' ? 504 : 499 });
    expect(listAdaptiveStates(comboId)).toHaveLength(0);
  }, 10_000);

  it('uses first content token rather than SSE metadata as streaming TTFT', async () => {
    const { reset, pushHandler } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const slowModelId = uuid();
    const fastModelId = uuid();
    const comboId = uuid();
    db.insert(schema.models).values({ id: slowModelId, providerId: provider.id, upstreamModelId: 'metadata-slow', publicModelId: `mock/metadata-slow-${slowModelId}`, displayName: 'Metadata slow model', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.models).values({ id: fastModelId, providerId: provider.id, upstreamModelId: 'metadata-fast', publicModelId: `mock/metadata-fast-${fastModelId}`, displayName: 'Metadata fast model', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.combos).values({
      id: comboId, name: 'slow-response-stream', slug: `slow-response-stream-${comboId}`,
      publicModelId: `combo/slow-response-stream-${comboId}`, mode: 'fallback', maxTotalAttempts: 2,
      slowResponseFallbackEnabled: true, slowResponseThresholdSeconds: 1, slowResponseMaxCount: 3,
    }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: slowModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: fastModelId, position: 1, enabled: true },
    ]).run();

    const seenModels: string[] = [];
    reset();
    pushHandler(async (_req, res, body) => {
      const model = (JSON.parse(body) as { model: string }).model;
      seenModels.push(model);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      if (model === 'metadata-slow') {
        res.write('data: {"choices":[{"index":0,"delta":{}}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[]}}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0}]}}]}\n\n');
        await new Promise((resolve) => setTimeout(resolve, 1300));
        res.write('data: {"choices":[{"index":0,"delta":{"content":"late"}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"index":0,"delta":{"content":"fallback"}}]}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: `combo/slow-response-stream-${comboId}`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(seenModels).toEqual(['metadata-slow', 'metadata-fast']);
    expect(text).toContain('fallback');
    expect(text).not.toContain('late');
  }, 10_000);

  it('preserves Anthropic input/cache usage when a metadata-only stream times out before fallback', async () => {
    const { reset, pushHandler } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const openAiProvider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const anthropicProviderId = uuid();
    const slowModelId = uuid();
    const backupModelId = uuid();
    const comboId = uuid();
    db.insert(schema.providers).values({
      ...openAiProvider,
      id: anthropicProviderId,
      name: 'mock-anthropic',
      slug: 'mock-anthropic',
      type: 'anthropic',
      connectTimeoutMs: 2000,
      firstTokenTimeoutMs: 300,
      streamIdleTimeoutMs: 2000,
      totalTimeoutMs: 5000,
    }).run();
    db.insert(schema.models).values({ id: slowModelId, providerId: anthropicProviderId, upstreamModelId: 'slow-anthropic', publicModelId: `mock-anthropic/slow-${slowModelId}`, displayName: 'Slow Anthropic', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.models).values({ id: backupModelId, providerId: openAiProvider.id, upstreamModelId: 'fast-backup', publicModelId: `mock/fast-backup-${backupModelId}`, displayName: 'Fast backup', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.combos).values({
      id: comboId, name: 'anthropic-metadata-timeout', slug: `anthropic-metadata-timeout-${comboId}`,
      publicModelId: `combo/anthropic-metadata-timeout-${comboId}`, mode: 'fallback', maxTotalAttempts: 2,
      slowResponseFallbackEnabled: false, fallbackOnFirstTokenTimeout: true,
    }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: slowModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: backupModelId, position: 1, enabled: true },
    ]).run();

    const seenModels: string[] = [];
    const attemptsBefore = db.select().from(schema.requestAttempts).all().length;
    const requestsBefore = db.select().from(schema.requests).all().length;
    reset();
    pushHandler(async (_req, res, body) => {
      const model = (JSON.parse(body) as { model: string }).model;
      seenModels.push(model);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      if (model === 'slow-anthropic') {
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","content":[],"model":"claude","usage":{"input_tokens":7,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}\n\n');
        return;
      }
      res.write('data: {"choices":[{"index":0,"delta":{"content":"backup"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: `combo/anthropic-metadata-timeout-${comboId}`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('backup');
    expect(seenModels).toEqual(['slow-anthropic', 'fast-backup']);

    let attempts = db.select().from(schema.requestAttempts).all();
    for (let i = 0; i < 40 && attempts.length <= attemptsBefore; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempts = db.select().from(schema.requestAttempts).all();
    }
    const slowAttempt = attempts.slice(attemptsBefore).find((attempt) => attempt.modelId === slowModelId);
    expect(slowAttempt).toMatchObject({ inputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1, failureReason: 'first_token_timeout' });
    const request = db.select().from(schema.requests).all().slice(requestsBefore)
      .find((row) => row.requestedModel === `combo/anthropic-metadata-timeout-${comboId}`);
    expect(request?.totalTokens).toBe(7);
  }, 10_000);

  it('treats OpenAI refusal-only streaming chunks as generated content', async () => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const db = (await import('../../src/server/db/index')).getDb();
    const { schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const refusalModelId = uuid();
    const backupModelId = uuid();
    const comboId = uuid();
    db.insert(schema.models).values({ id: refusalModelId, providerId: provider.id, upstreamModelId: 'refusal-first', publicModelId: `mock/refusal-first-${refusalModelId}`, displayName: 'Refusal first', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.models).values({ id: backupModelId, providerId: provider.id, upstreamModelId: 'refusal-backup', publicModelId: `mock/refusal-backup-${backupModelId}`, displayName: 'Refusal backup', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.combos).values({ id: comboId, name: 'refusal-is-content', slug: `refusal-is-content-${comboId}`, publicModelId: `combo/refusal-is-content-${comboId}`, mode: 'fallback', maxTotalAttempts: 2 }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: refusalModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: backupModelId, position: 1, enabled: true },
    ]).run();
    const seenModels: string[] = [];
    reset();
    pushHandler((_req, res, body) => {
      const model = (JSON.parse(body) as { model: string }).model;
      seenModels.push(model);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      if (model === 'refusal-first') {
        res.write('data: {"choices":[{"index":0,"delta":{"refusal":"I cannot help with that request."}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"index":0,"delta":{"content":"backup"}}]}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: `combo/refusal-is-content-${comboId}`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"refusal":"I cannot help with that request."');
    expect(seenModels).toEqual(['refusal-first']);
    expect(callCount()).toBe(1);
  });

  it('cancels the upstream stream when the downstream client disconnects', async () => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const db = (await import('../../src/server/db/index')).getDb();
    const { schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const firstModelId = uuid();
    const backupModelId = uuid();
    const comboId = uuid();
    db.insert(schema.models).values({ id: firstModelId, providerId: provider.id, upstreamModelId: 'disconnect-first', publicModelId: `mock/disconnect-first-${firstModelId}`, displayName: 'Disconnect first', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.models).values({ id: backupModelId, providerId: provider.id, upstreamModelId: 'disconnect-backup', publicModelId: `mock/disconnect-backup-${backupModelId}`, displayName: 'Disconnect backup', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.combos).values({ id: comboId, name: 'disconnect-cancels-upstream', slug: `disconnect-cancels-upstream-${comboId}`, publicModelId: `combo/disconnect-cancels-upstream-${comboId}`, mode: 'fallback', maxTotalAttempts: 2 }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: firstModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: backupModelId, position: 1, enabled: true },
    ]).run();
    let upstreamClosed = false;
    const seenModels: string[] = [];
    reset();
    pushHandler((_req, res, body) => {
      seenModels.push((JSON.parse(body) as { model: string }).model);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: {"choices":[{"index":0,"delta":{"content":"first token"}}]}\n\n');
      res.on('close', () => { upstreamClosed = true; });
    });

    const downstream = new AbortController();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: `combo/disconnect-cancels-upstream-${comboId}`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: downstream.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('first token');
    downstream.abort();
    await reader.cancel().catch(() => undefined);

    for (let i = 0; i < 40 && !upstreamClosed; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(upstreamClosed).toBe(true);
    expect(seenModels).toEqual(['disconnect-first']);
    expect(callCount()).toBe(1);
  });

  it('preserves usage received after stream commit when the provider later idles out', async () => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const db = (await import('../../src/server/db/index')).getDb();
    const { schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const originalIdleTimeout = provider.streamIdleTimeoutMs;
    const originalHealthState = provider.healthState;
    const aggregateDay = new Date().toISOString().slice(0, 10);
    const providerStatsBefore = db.select().from(schema.dailyProviderStats).all()
      .find((row) => row.day === aggregateDay && row.providerId === provider.id);
    const cacheReadBefore = providerStatsBefore?.cacheReadTokens ?? 0;
    const reasoningBefore = providerStatsBefore?.reasoningTokens ?? 0;
    const firstModelId = uuid();
    const backupModelId = uuid();
    const comboId = uuid();
    db.insert(schema.models).values({ id: firstModelId, providerId: provider.id, upstreamModelId: 'idle-first', publicModelId: `mock/idle-first-${firstModelId}`, displayName: 'Idle first', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.models).values({ id: backupModelId, providerId: provider.id, upstreamModelId: 'idle-backup', publicModelId: `mock/idle-backup-${backupModelId}`, displayName: 'Idle backup', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.combos).values({ id: comboId, name: 'post-commit-usage', slug: `post-commit-usage-${comboId}`, publicModelId: `combo/post-commit-usage-${comboId}`, mode: 'fallback', maxTotalAttempts: 2 }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: firstModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: backupModelId, position: 1, enabled: true },
    ]).run();
    const attemptsBefore = db.select().from(schema.requestAttempts).all().length;
    const requestsBefore = db.select().from(schema.requests).all().length;
    const seenModels: string[] = [];
    reset();
    db.update(schema.providers).set({ streamIdleTimeoutMs: 120, healthState: 'healthy' }).where(eq(schema.providers.id, provider.id)).run();
    try {
      pushHandler((_req, res, body) => {
        seenModels.push((JSON.parse(body) as { model: string }).model);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":3}}}\n\n');
        // Keep the upstream socket open until the stream-idle watchdog aborts it.
      });
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
        body: JSON.stringify({ model: `combo/post-commit-usage-${comboId}`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"content":"partial"');
      expect(seenModels).toEqual(['idle-first']);
      expect(callCount()).toBe(1);

      let attempts = db.select().from(schema.requestAttempts).all();
      for (let i = 0; i < 40 && attempts.length <= attemptsBefore; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        attempts = db.select().from(schema.requestAttempts).all();
      }
      const attempt = attempts.slice(attemptsBefore).find((row) => row.modelId === firstModelId);
      expect(attempt).toMatchObject({
        success: false,
        partialResponse: true,
        failureReason: 'stream_idle_timeout',
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 4,
        reasoningTokens: 3,
      });
      const request = db.select().from(schema.requests).all().slice(requestsBefore)
        .find((row) => row.requestedModel === `combo/post-commit-usage-${comboId}`);
      expect(request).toMatchObject({ totalTokens: 18, cacheReadTokens: 4, reasoningTokens: 3 });
      const { listAdaptiveStates } = await import('../../src/server/routing/combo-adaptive-state');
      const state = listAdaptiveStates(comboId).find((row) => row.modelId === firstModelId);
      expect(state?.samples ?? []).toHaveLength(0);
      const providerStats = db.select().from(schema.dailyProviderStats).all()
        .find((row) => row.day === aggregateDay && row.providerId === provider.id);
      expect(providerStats?.cacheReadTokens).toBe(cacheReadBefore + 4);
      expect(providerStats?.reasoningTokens).toBe(reasoningBefore + 3);
      expect(db.select().from(schema.providers).all().find((row) => row.id === provider.id)?.healthState).toBe('down');
    } finally {
      db.update(schema.providers).set({ streamIdleTimeoutMs: originalIdleTimeout, healthState: originalHealthState }).where(eq(schema.providers.id, provider.id)).run();
    }
  }, 10_000);

  it('preserves Anthropic cache-write usage when a committed stream later idles out', async () => {
    const { reset, pushHandler, callCount } = await import('./_mock-control.js');
    const { getDb, schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const db = getDb();
    const openAiProvider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const anthropicProviderId = uuid();
    const slowModelId = uuid();
    const backupModelId = uuid();
    const comboId = uuid();
    db.insert(schema.providers).values({
      ...openAiProvider,
      id: anthropicProviderId,
      name: 'mock-anthropic-post-content',
      slug: 'mock-anthropic-post-content',
      type: 'anthropic',
      connectTimeoutMs: 2000,
      firstTokenTimeoutMs: 300,
      streamIdleTimeoutMs: 120,
      totalTimeoutMs: 5000,
    }).run();
    db.insert(schema.models).values({ id: slowModelId, providerId: anthropicProviderId, upstreamModelId: 'slow-anthropic-post-content', publicModelId: `mock-anthropic-post-content/slow-${slowModelId}`, displayName: 'Slow Anthropic post-content', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.models).values({ id: backupModelId, providerId: openAiProvider.id, upstreamModelId: 'unused-backup', publicModelId: `mock/unused-backup-${backupModelId}`, displayName: 'Unused backup', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.combos).values({
      id: comboId,
      name: 'anthropic-post-content-usage',
      slug: `anthropic-post-content-usage-${comboId}`,
      publicModelId: `combo/anthropic-post-content-usage-${comboId}`,
      mode: 'fallback',
      maxTotalAttempts: 2,
      slowResponseFallbackEnabled: false,
      fallbackOnFirstTokenTimeout: true,
    }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: slowModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: backupModelId, position: 1, enabled: true },
    ]).run();

    const provider = db.select().from(schema.providers).all().find((row) => row.id === anthropicProviderId)!;
    const originalIdleTimeout = provider.streamIdleTimeoutMs;
    const originalHealthState = provider.healthState;
    const aggregateDay = new Date().toISOString().slice(0, 10);
    const providerStatsBefore = db.select().from(schema.dailyProviderStats).all()
      .find((row) => row.day === aggregateDay && row.providerId === anthropicProviderId);
    const cacheReadBefore = providerStatsBefore?.cacheReadTokens ?? 0;
    const cacheWriteBefore = providerStatsBefore?.cacheWriteTokens ?? 0;
    const reasoningBefore = providerStatsBefore?.reasoningTokens ?? 0;
    const attemptsBefore = db.select().from(schema.requestAttempts).all().length;
    const requestsBefore = db.select().from(schema.requests).all().length;
    const seenModels: string[] = [];
    reset();
    db.update(schema.providers).set({ streamIdleTimeoutMs: 120, healthState: 'healthy' }).where(eq(schema.providers.id, anthropicProviderId)).run();
    try {
      pushHandler((_req, res, body) => {
        seenModels.push((JSON.parse(body) as { model: string }).model);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg-post","type":"message","role":"assistant","content":[],"model":"claude","usage":{"input_tokens":7,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n');
        // Keep the upstream socket open until the idle watchdog aborts it.
      });

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
        body: JSON.stringify({ model: `combo/anthropic-post-content-usage-${comboId}`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('partial');
      expect(seenModels).toEqual(['slow-anthropic-post-content']);
      expect(callCount()).toBe(1);

      let attempts = db.select().from(schema.requestAttempts).all();
      for (let i = 0; i < 40 && attempts.length <= attemptsBefore; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        attempts = db.select().from(schema.requestAttempts).all();
      }
      const attempt = attempts.slice(attemptsBefore).find((row) => row.modelId === slowModelId);
      expect(attempt).toMatchObject({
        success: false,
        streamStarted: true,
        partialResponse: true,
        failureReason: 'stream_idle_timeout',
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      });
      const request = db.select().from(schema.requests).all().slice(requestsBefore)
        .find((row) => row.requestedModel === `combo/anthropic-post-content-usage-${comboId}`);
      expect(request).toMatchObject({ totalTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1 });
      const providerStats = db.select().from(schema.dailyProviderStats).all()
        .find((row) => row.day === aggregateDay && row.providerId === anthropicProviderId);
      expect(providerStats?.cacheReadTokens).toBe(cacheReadBefore + 2);
      expect(providerStats?.cacheWriteTokens).toBe(cacheWriteBefore + 1);
      expect(providerStats?.reasoningTokens).toBe(reasoningBefore);
      expect(db.select().from(schema.providers).all().find((row) => row.id === anthropicProviderId)?.healthState).toBe('down');
    } finally {
      db.update(schema.providers).set({ streamIdleTimeoutMs: originalIdleTimeout, healthState: originalHealthState }).where(eq(schema.providers.id, anthropicProviderId)).run();
    }
  }, 10_000);

  it('chat completions: streaming success', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    reset();
    pushHandler((_req, res, body) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: {"choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n`);
      res.write(`data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n`);
      res.write(`data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      void body;
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: 'mock/gpt-mock', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // SSE delivers token deltas as separate frames; the client concatenates.
    expect(text).toContain('"content":"hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).toContain('data: [DONE]');
  });

  it('streamed requests ask the upstream for usage so tokens are not lost', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    const { getDb, schema } = await import('../../src/server/db/index');
    reset();
    let upstreamBody = '';
    // Faithful OpenAI-compatible upstream: it reports usage on a streamed answer
    // only when the caller opted in with stream_options.include_usage.
    pushHandler((_req, res, body) => {
      upstreamBody = body;
      const wantsUsage = Boolean((JSON.parse(body) as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`);
      res.write(
        wantsUsage
          ? `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n`
          : `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: 'mock/gpt-mock', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const db = getDb();
    // Streaming closes the client connection before the gateway persists.
    for (let i = 0; i < 40; i++) {
      const row = db.select().from(schema.requests).all().pop();
      if (row && row.inputTokens > 0) {
        expect(row.inputTokens).toBe(11);
        expect(row.outputTokens).toBe(7);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`gateway never persisted streamed usage; upstream body was ${upstreamBody}`);
  });

  it('fallback before stream: returns 502 when upstream 429s and no fallback configured', async () => {
    const { reset, pushHandler } = (await import('./_mock-control.js'));
    reset();
    pushHandler((_req, res) => {
      res.statusCode = 429;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: 'mock/gpt-mock', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // No combo fallback, single direct model — gateway should return 502/529
    expect([429, 502, 529]).toContain(res.status);
  });

  it('does not fallback after combo stream content has been sent', async () => {
    const { reset, pushHandler, callCount } = (await import('./_mock-control.js'));
    reset();
    const db = (await import('../../src/server/db/index')).getDb();
    const { schema } = await import('../../src/server/db/index');
    const { uuid } = await import('../../src/server/auth/ids');
    const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
    const firstModelId = uuid();
    const backupModelId = uuid();
    const comboId = uuid();
    db.insert(schema.models).values({ id: firstModelId, providerId: provider.id, upstreamModelId: 'partial-first', publicModelId: `mock/partial-first-${firstModelId}`, displayName: 'Partial first', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.models).values({ id: backupModelId, providerId: provider.id, upstreamModelId: 'partial-backup', publicModelId: `mock/partial-backup-${backupModelId}`, displayName: 'Partial backup', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
    db.insert(schema.combos).values({ id: comboId, name: 'no-fallback-after-commit', slug: `no-fallback-after-commit-${comboId}`, publicModelId: `combo/no-fallback-after-commit-${comboId}`, mode: 'fallback', maxTotalAttempts: 2 }).run();
    db.insert(schema.comboMembers).values([
      { id: uuid(), comboId, modelId: firstModelId, position: 0, enabled: true },
      { id: uuid(), comboId, modelId: backupModelId, position: 1, enabled: true },
    ]).run();
    const before = db.select().from(schema.requestAttempts).all().length;
    const seenModels: string[] = [];
    pushHandler((_req, res, body) => {
      seenModels.push((JSON.parse(body) as { model: string }).model);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n`);
      // let the chunk flush, then kill the upstream connection
      setTimeout(() => res.destroy(), 50);
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: `combo/no-fallback-after-commit-${comboId}`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    // The committed content reached the client before the failure, and no
    // fallback to a second model occurred (the upstream was called once).
    expect(callCount()).toBe(1);
    expect(seenModels).toEqual(['partial-first']);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"content":"partial"');
    // Streaming responses close the client connection before the gateway
    // persists, so poll briefly for the attempt row.
    for (let i = 0; i < 40; i++) {
      const attempts = db.select().from(schema.requestAttempts).all();
      if (attempts.length > before) {
        const last = attempts[attempts.length - 1]!;
        expect(last.streamStarted).toBe(true);
        expect(last.partialResponse).toBe(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('expected streaming attempt to be persisted');
  });
});
