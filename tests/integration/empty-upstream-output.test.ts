// Regression coverage: upstream HTTP 200 with input usage but no assistant output.
// A response is useful if it contains text or a valid tool call; token accounting
// alone cannot determine that (tool calls may report zero output tokens).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http, { type ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { callCount, pushHandler, reset, take } from './_mock-control';

const dataDir = path.join(os.tmpdir(), `latedev-empty-output-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

type Protocol = 'openai' | 'anthropic';
type Side = 'first' | 'second';
type ModelFixture = { id: string; providerId: string; publicModelId: string; upstreamModelId: string };
type ResponseError = { error: { type: string; code?: string; message: string } };

let app: import('fastify').FastifyInstance | undefined;
let upstream: http.Server | undefined;
let baseUrl = '';
let apiKey = '';
let db: ReturnType<(typeof import('../../src/server/db/index'))['getDb']>;
let sch: typeof import('../../src/server/db/schema');
const models = {} as Record<Protocol, Record<Side, ModelFixture>>;
const comboIds = {} as Record<Protocol, string>;

const openaiEmpty = {
  id: 'empty-chat', object: 'chat.completion', model: 'a',
  choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 17, completion_tokens: 0, total_tokens: 17 },
};
const openaiText = {
  id: 'text-chat', object: 'chat.completion', model: 'b',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Recovered answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
};
const openaiTool = {
  id: 'tool-chat', object: 'chat.completion', model: 'a',
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
    { id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"id":7}' } },
  ] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 17, completion_tokens: 0, total_tokens: 17 },
};
const anthropicEmpty = {
  id: 'msg_empty', type: 'message', role: 'assistant', model: 'a', content: [], stop_reason: 'end_turn',
  usage: { input_tokens: 17, output_tokens: 0 },
};
const anthropicText = {
  id: 'msg_recovered', type: 'message', role: 'assistant', model: 'b',
  content: [{ type: 'text', text: 'Recovered answer' }], stop_reason: 'end_turn',
  usage: { input_tokens: 8, output_tokens: 3 },
};
const anthropicTool = {
  id: 'msg_tool', type: 'message', role: 'assistant', model: 'a',
  content: [{ type: 'tool_use', id: 'tool_lookup', name: 'lookup', input: { id: 7 } }],
  stop_reason: 'tool_use', usage: { input_tokens: 17, output_tokens: 0 },
};

function json(res: ServerResponse, value: unknown): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

function sse(res: ServerResponse, events: Array<{ payload: unknown; event?: string }>): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  for (const item of events) {
    res.write(`${item.event ? `event: ${item.event}\n` : ''}data: ${JSON.stringify(item.payload)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

function openaiEvents(useful: 'none' | 'text' | 'tool', id: string) {
  const events: Array<{ payload: unknown }> = [
    { payload: { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } },
  ];
  if (useful === 'text') events.push({ payload: { id, choices: [{ index: 0, delta: { content: 'Recovered answer' }, finish_reason: null }] } });
  if (useful === 'tool') events.push({ payload: { id, choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"id":7}' } },
  ] }, finish_reason: null }] } });
  events.push({ payload: { id, choices: [{ index: 0, delta: {}, finish_reason: useful === 'tool' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 17, completion_tokens: useful === 'text' ? 3 : 0, total_tokens: useful === 'text' ? 20 : 17 } } });
  return events;
}

function anthropicEvents(useful: 'none' | 'text' | 'tool', id: string) {
  const events: Array<{ event: string; payload: unknown }> = [
    { event: 'message_start', payload: { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], usage: { input_tokens: 17, output_tokens: 0 } } } },
  ];
  if (useful === 'text') {
    events.push({ event: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    events.push({ event: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered answer' } } });
  }
  if (useful === 'tool') events.push({ event: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_lookup', name: 'lookup', input: { id: 7 } } } });
  events.push({ event: 'message_delta', payload: { type: 'message_delta', delta: { stop_reason: useful === 'tool' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: useful === 'text' ? 3 : 0 } } });
  events.push({ event: 'message_stop', payload: { type: 'message_stop' } });
  return events;
}

function request(protocol: Protocol, model: string, stream = false): Promise<Response> {
  const anthropic = protocol === 'anthropic';
  return fetch(`${baseUrl}${anthropic ? '/v1/messages' : '/v1/chat/completions'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, stream, messages: [{ role: 'user', content: 'Hello' }],
      ...(anthropic ? { max_tokens: 64 } : {}),
    }),
  });
}

async function recordedRequestSince(count: number) {
  for (let i = 0; i < 60; i++) {
    const rows = db.select().from(sch.requests).all();
    if (rows.length > count) return rows[rows.length - 1]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Gateway request result was never persisted');
}

function requestCount(): number {
  return db.select().from(sch.requests).all().length;
}

function attemptRows(id: string) {
  return db.select().from(sch.requestAttempts).where(eq(sch.requestAttempts.requestId, id)).all()
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const handler = take();
      if (!handler) { res.statusCode = 500; res.end('missing mock handler'); return; }
      void handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('missing mock address');

  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const appAddress = app.server.address();
  if (!appAddress || typeof appAddress === 'string') throw new Error('missing gateway address');
  baseUrl = `http://127.0.0.1:${appAddress.port}`;
  const setup = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  if (!setup.ok) throw new Error(`setup failed: ${setup.status}`);
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie') ?? '';
  const keyRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'empty-output-test', allowAllModels: true }),
  });
  if (!keyRes.ok) throw new Error(`API key failed: ${keyRes.status}`);
  apiKey = ((await keyRes.json()) as { secret: string }).secret;

  db = (await import('../../src/server/db/index')).getDb();
  sch = await import('../../src/server/db/schema');
  const { uuid } = await import('../../src/server/auth/ids');
  for (const protocol of ['openai', 'anthropic'] as const) {
    models[protocol] = {} as Record<Side, ModelFixture>;
    for (const side of ['first', 'second'] as const) {
      const slug = `empty-${protocol}-${side}`;
      const providerRes = await fetch(`${baseUrl}/api/admin/providers`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: slug, slug, type: protocol, baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'sk-test', enabled: true, maxRetries: 0, totalTimeoutMs: 5000 }),
      });
      if (!providerRes.ok) throw new Error(`provider ${slug} failed: ${providerRes.status} ${await providerRes.text()}`);
      const provider = db.select().from(sch.providers).all().find((entry) => entry.slug === slug);
      if (!provider) throw new Error(`provider ${slug} was not saved`);
      const model: ModelFixture = { id: uuid(), providerId: provider.id, publicModelId: `${slug}/model-${side}`, upstreamModelId: `model-${side}` };
      models[protocol][side] = model;
      db.insert(sch.models).values({ id: model.id, providerId: provider.id, upstreamModelId: model.upstreamModelId, publicModelId: model.publicModelId, displayName: side, enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true, tools: true }) }).run();
    }
    const comboId = uuid();
    comboIds[protocol] = `combo/empty-${protocol}`;
    db.insert(sch.combos).values({ id: comboId, name: `empty-${protocol}`, slug: `empty-${protocol}`, publicModelId: comboIds[protocol], mode: 'fallback', enabled: true, maxTotalAttempts: 2 }).run();
    for (const [position, side] of (['first', 'second'] as const).entries()) {
      db.insert(sch.comboMembers).values({ id: uuid(), comboId, modelId: models[protocol][side].id, position, enabled: true }).run();
    }
  }
});

beforeEach(async () => {
  reset();
  const { recordSuccess } = await import('../../src/server/routing/circuit');
  for (const protocol of ['openai', 'anthropic'] as const) {
    for (const side of ['first', 'second'] as const) {
      const id = models[protocol][side].providerId;
      recordSuccess(id);
      db.update(sch.providers).set({ maxRetries: 0, healthState: 'healthy' }).where(eq(sch.providers.id, id)).run();
    }
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
});

describe('upstream 200 without semantic output', () => {
  it('rejects empty OpenAI chat as 502 upstream_empty_response, recording a failed attempt', async () => {
    const before = requestCount();
    pushHandler((_req, res) => json(res, openaiEmpty));
    const response = await request('openai', models.openai.first.publicModelId);
    expect(response.status).toBe(502);
    expect(((await response.json()) as ResponseError).error.code).toBe('upstream_empty_response');
    const logged = await recordedRequestSince(before);
    expect(logged).toMatchObject({ success: false, httpStatus: 502, requestedModel: models.openai.first.publicModelId });
    expect(attemptRows(logged.id)).toMatchObject([{ success: false }]);
    expect(callCount()).toBe(1);
  });

  it('honors provider maxRetries for empty direct-model responses', async () => {
    db.update(sch.providers).set({ maxRetries: 1 }).where(eq(sch.providers.id, models.openai.first.providerId)).run();
    pushHandler((_req, res) => json(res, openaiEmpty));
    const response = await request('openai', models.openai.first.publicModelId);
    expect(response.status).toBe(502);
    expect(((await response.json()) as ResponseError).error.code).toBe('upstream_empty_response');
    expect(callCount()).toBe(2); // initial attempt + exactly one configured retry
  });

  it('evicts legacy cached empty HTTP 200 and fetches useful output from upstream', async () => {
    const { buildCacheKey } = await import('../../src/server/caching/store');
    const { openAIToCanonical } = await import('../../src/server/protocols/canonical');
    const { uuid } = await import('../../src/server/auth/ids');
    const model = models.openai.first;
    const canonicalRequest = openAIToCanonical({ model: model.publicModelId, messages: [{ role: 'user', content: 'Hello' }], stream: false });
    const cacheKey = buildCacheKey({
      protocol: 'openai', resolvedTargetKind: 'model', resolvedTargetId: model.id, configVersion: 1, canonicalRequest,
    });
    const legacyJson = JSON.stringify(openaiEmpty);
    db.update(sch.appSettings).set({ gatewayCacheEnabled: true }).where(eq(sch.appSettings.id, 1)).run();
    try {
      db.insert(sch.responseCache).values({
        id: uuid(), cacheKey, targetKind: 'model', targetId: model.id, targetConfigVersion: 1,
        protocol: 'openai', responseJson: legacyJson,
        usageJson: JSON.stringify({ input: 17, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), bytes: Buffer.byteLength(legacyJson),
      }).run();
      pushHandler((_req, res) => json(res, openaiText));
      const response = await request('openai', model.publicModelId);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('Recovered answer');
      expect(callCount()).toBe(1);
      const cache = db.select().from(sch.responseCache).where(eq(sch.responseCache.cacheKey, cacheKey)).get();
      expect(cache).toBeDefined();
      expect(JSON.parse(cache!.responseJson).choices[0].message.content).toBe('Recovered answer');
    } finally {
      db.update(sch.appSettings).set({ gatewayCacheEnabled: false }).where(eq(sch.appSettings.id, 1)).run();
      db.delete(sch.responseCache).where(eq(sch.responseCache.cacheKey, cacheKey)).run();
    }
  });

  it('falls back from empty OpenAI chat to a healthy combo member', async () => {
    const before = requestCount();
    pushHandler((_req, res, body) => json(res, JSON.parse(body).model === 'model-first' ? openaiEmpty : openaiText));
    const response = await request('openai', comboIds.openai);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('Recovered answer');
    expect(callCount()).toBe(2);
    const logged = await recordedRequestSince(before);
    expect(logged).toMatchObject({ success: true, httpStatus: 200, finalModelId: models.openai.second.id });
    expect(attemptRows(logged.id)).toMatchObject([{ success: false, modelId: models.openai.first.id }, { success: true, modelId: models.openai.second.id }]);
  });

  it('accepts OpenAI tool_calls with null text and zero reported completion tokens', async () => {
    pushHandler((_req, res) => json(res, openaiTool));
    const response = await request('openai', models.openai.first.publicModelId);
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: Array<{ message: { content: string | null; tool_calls: Array<{ function: { name: string } }> } }> };
    expect(body.choices[0]!.message.tool_calls[0]!.function.name).toBe('lookup');
    expect(callCount()).toBe(1);
  });

  it('accepts nonempty OpenAI text even when usage reports zero output tokens', async () => {
    pushHandler((_req, res) => json(res, { ...openaiText, usage: { prompt_tokens: 17, completion_tokens: 0, total_tokens: 17 } }));
    const response = await request('openai', models.openai.first.publicModelId);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('Recovered answer');
  });

  it('returns HTTP 502 for OpenAI stream containing only role, finish and usage metadata', async () => {
    pushHandler((_req, res) => sse(res, openaiEvents('none', 'empty-only')));
    const response = await request('openai', models.openai.first.publicModelId, true);
    expect(response.status).toBe(502);
    expect(((await response.json()) as ResponseError).error.code).toBe('upstream_empty_response');
  });

  it('holds metadata-only SSE prelude before combo fallback and streams only the useful member', async () => {
    const before = requestCount();
    pushHandler((_req, res, body) => sse(res, JSON.parse(body).model === 'model-first' ? openaiEvents('none', 'first-empty') : openaiEvents('text', 'second-success')));
    const response = await request('openai', comboIds.openai, true);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('Recovered answer');
    expect(stream).not.toContain('first-empty');
    expect(callCount()).toBe(2);
    const logged = await recordedRequestSince(before);
    expect(logged).toMatchObject({ success: true, httpStatus: 200, finalModelId: models.openai.second.id });
    expect(attemptRows(logged.id)).toMatchObject([{ success: false }, { success: true }]);
  });

  it('streams OpenAI tool_calls successfully even with output_tokens=0', async () => {
    pushHandler((_req, res) => sse(res, openaiEvents('tool', 'valid-tool')));
    const response = await request('openai', models.openai.first.publicModelId, true);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('call_lookup');
    expect(stream).toContain('data: [DONE]');
  });

  it('rejects empty Anthropic message 200 while preserving Anthropic error envelope', async () => {
    pushHandler((_req, res) => json(res, anthropicEmpty));
    const response = await request('anthropic', models.anthropic.first.publicModelId);
    expect(response.status).toBe(502);
    const body = await response.json() as ResponseError & { type: string };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('upstream_error');
    expect(body.error.message).toMatch(/empty|output|content/i);
  });

  it('falls back from empty Anthropic messages to a valid combo response', async () => {
    const before = requestCount();
    pushHandler((_req, res, body) => json(res, JSON.parse(body).model === 'model-first' ? anthropicEmpty : anthropicText));
    const response = await request('anthropic', comboIds.anthropic);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { content: Array<{ type: string; text: string }> }).content).toMatchObject([{ type: 'text', text: 'Recovered answer' }]);
    expect(callCount()).toBe(2);
    const logged = await recordedRequestSince(before);
    expect(logged).toMatchObject({ success: true, httpStatus: 200, finalModelId: models.anthropic.second.id });
    expect(attemptRows(logged.id)).toMatchObject([{ success: false }, { success: true }]);
  });

  it('accepts Anthropic tool_use with zero output tokens', async () => {
    pushHandler((_req, res) => json(res, anthropicTool));
    const response = await request('anthropic', models.anthropic.first.publicModelId);
    expect(response.status).toBe(200);
    const body = await response.json() as { content: Array<{ type: string; name: string }> };
    expect(body.content).toMatchObject([{ type: 'tool_use', name: 'lookup' }]);
  });

  it('rejects Anthropic metadata-only stream without committing a 200 SSE response', async () => {
    pushHandler((_req, res) => sse(res, anthropicEvents('none', 'anthropic-empty')));
    const response = await request('anthropic', models.anthropic.first.publicModelId, true);
    expect(response.status).toBe(502);
    expect(((await response.json()) as ResponseError).error.type).toBe('upstream_error');
  });

  it('falls back after an empty Anthropic stream and returns only the second member', async () => {
    pushHandler((_req, res, body) => sse(res, JSON.parse(body).model === 'model-first' ? anthropicEvents('none', 'anthropic-empty') : anthropicEvents('text', 'anthropic-recovered')));
    const response = await request('anthropic', comboIds.anthropic, true);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('Recovered answer');
    expect(stream).not.toContain('anthropic-empty');
    expect(callCount()).toBe(2);
  });

  it('streams Anthropic tool_use even with output_tokens=0', async () => {
    pushHandler((_req, res) => sse(res, anthropicEvents('tool', 'anthropic-tool')));
    const response = await request('anthropic', models.anthropic.first.publicModelId, true);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('tool_lookup');
    expect(callCount()).toBe(1);
  });
});
