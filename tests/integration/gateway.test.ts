// Integration tests: full setup, login, providers, models, API key, gateway request via mock upstream.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    capabilitiesJson: JSON.stringify({ chat: true, streaming: true, tools: true }),
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
  recordSuccess('mock');
});

describe('gateway smoke', () => {
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
    db.insert(sch.comboMembers).values({ id: uuid(), comboId, modelId: model.id, position: 0, weight: 1, enabled: true }).run();
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
        body: JSON.stringify({ mode: 'fallback', members: [{ modelId: model.id, position: 0, weight: 1, enabled: true }], ...payload }),
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

  it('does not fallback after stream content sent', async () => {
    const { reset, pushHandler, callCount } = (await import('./_mock-control.js'));
    reset();
    const db = (await import('../../src/server/db/index')).getDb();
    const { schema } = await import('../../src/server/db/index');
    const before = db.select().from(schema.requestAttempts).all().length;
    pushHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n`);
      // let the chunk flush, then kill the upstream connection
      setTimeout(() => res.destroy(), 50);
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
      body: JSON.stringify({ model: 'mock/gpt-mock', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    // The committed content reached the client before the failure, and no
    // fallback to a second model occurred (the upstream was called once).
    expect(callCount()).toBe(1);
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
