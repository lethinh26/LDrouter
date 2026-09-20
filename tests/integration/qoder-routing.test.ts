// Qoder routing integration: a real gateway request through the account pool against a stubbed
// Qoder upstream. The provider's base URL is not configurable (QODER_CHAT_URL is a constant), so
// the stub wraps global fetch and intercepts only qoder.sh, passing everything else through —
// stubbing it wholesale would break this test's own HTTP calls to the in-process server.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `latedev-qoder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'b'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let csrfCookies = '';
let apiKey: { id: string; secret: string } | undefined;
let healthyAccountId = '';
let downAccountId = '';

const CATALOG = JSON.stringify({
  fetchedAt: '2026-09-16T00:00:00.000Z',
  entries: [{
    key: 'qmodel_38max', displayName: 'Qwen3.8-Max', enabled: true, isReasoning: false, isVl: false,
    maxInputTokens: 200_000, maxOutputTokens: 32_768,
    raw: { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, max_input_tokens: 200_000, max_output_tokens: 32_768, source: 'system' },
  }],
});

const envelope = (inner: unknown) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
const QODER_BODY = [
  envelope({ id: 'c1', choices: [{ index: 0, delta: { content: 'from qoder' } }] }),
  envelope({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  envelope({ id: 'c1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
  'data: [DONE]\n\n',
].join('');

let realFetch: typeof fetch;
/** Number of chat completions attempted, so the test can prove the healthy account served it. */
let qoderCalls = 0;

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;

  await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  }).then((r) => { if (!r.ok) throw new Error(`setup ${r.status}`); });

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  if (!loginRes.ok) throw new Error(`login ${loginRes.status}`);
  csrfCookies = loginRes.headers.get('set-cookie') ?? '';

  const db = (await import('../../src/server/db/index')).getDb();
  const sch = await import('../../src/server/db/schema');
  const { uuid } = await import('../../src/server/auth/ids');
  const { insertQoderAccount, saveQoderCatalog, setQoderAccountHealth } = await import('../../src/server/db/repositories/qoder-accounts');

  const providerId = uuid();
  db.insert(sch.providers).values({
    id: providerId, name: 'Qoder', slug: 'qoder', type: 'qoder', baseUrl: 'https://api2.qoder.sh',
    encryptedApiKey: null, apiKeyNonce: null, apiKeyVersion: 1, enabled: true,
    connectTimeoutMs: 5000, firstTokenTimeoutMs: 5000, streamIdleTimeoutMs: 5000, totalTimeoutMs: 5000,
    maxRetries: 0, retryBaseMs: 100, retryMaxMs: 1000, cbFailureThreshold: 3, cbCooldownSeconds: 30,
    healthState: 'unknown', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never).run();

  db.insert(sch.models).values({
    id: uuid(), providerId, upstreamModelId: 'qmodel_38max', publicModelId: 'qoder/qmodel_38max',
    displayName: 'Qwen3.8-Max', enabled: true, upstreamAvailable: true,
    capabilitiesJson: JSON.stringify({ chat: true, streaming: true, tools: true }),
  }).run();

  const farFuture = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const account = (index: number, userId: string) => ({
    index, personalToken: `pt-${'x'.repeat(20)}${index}`, jobToken: 'jt-token', jobTokenExpiresAt: farFuture,
    qoderUserId: userId, machineId: 'machine-1', email: `${userId}@example.com`, label: `acct-${index}`,
  });
  healthyAccountId = insertQoderAccount(providerId, account(1, 'user-healthy'));
  downAccountId = insertQoderAccount(providerId, account(2, 'user-down'));
  saveQoderCatalog(healthyAccountId, CATALOG, '2026-09-16T00:00:00.000Z');
  saveQoderCatalog(downAccountId, CATALOG, '2026-09-16T00:00:00.000Z');
  setQoderAccountHealth(downAccountId, 'down', 'personal access token rejected — replace it');

  const keyRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: csrfCookies },
    body: JSON.stringify({ name: 'qoder-test', allowAllModels: true }),
  });
  if (!keyRes.ok) throw new Error(`key ${keyRes.status}`);
  apiKey = (await keyRes.json()) as { id: string; secret: string };

  realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes('qoder.sh')) return realFetch(input, init);
    if (url.includes('agent_chat_generation')) {
      qoderCalls += 1;
      return Promise.resolve(new Response(QODER_BODY, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'qoder-up-1' } }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const chat = (model: string, stream = false) => fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey!.secret}` },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream }),
});

describe('Qoder account-pool routing', () => {
  it('serves a request through the healthy account and records it on the attempt', async () => {
    const res = await chat('qoder/qmodel_38max');
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('from qoder');

    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const attempts = db.select().from(sch.requestAttempts).all();
    const qoderAttempts = attempts.filter((a) => a.qoderAccountId !== null);
    expect(qoderAttempts.length).toBeGreaterThan(0);
    // Only the healthy account is ever named — the `down` one is filtered before dispatch.
    expect(qoderAttempts.every((a) => a.qoderAccountId === healthyAccountId)).toBe(true);
  });

  it('streams Qoder chunks through to the client', async () => {
    const res = await chat('qoder/qmodel_38max', true);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('from qoder');
    expect(body).toContain('[DONE]');
  });

  // Reported as "Tokens in 0 · out 0 · cache 0" for every Qoder request. The upstream usage
  // frame is OpenAI-shaped (the stub sends `prompt_tokens`), but the runner only parsed usage
  // for `cfg.type === 'openai'`, leaving the accumulator at zero for Qoder.
  it('records the upstream token usage on the request and its attempt', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const { eq } = await import('drizzle-orm');
    const before = db.select().from(sch.requests).all().length;

    const res = await chat('qoder/qmodel_38max');
    expect(res.status).toBe(200);
    await res.json();

    const rows = db.select().from(sch.requests).all();
    const row = rows.filter((r) => r.requestedModel === 'qoder/qmodel_38max').at(-1)!;
    expect(rows.length).toBeGreaterThan(before);
    // The stub reported prompt_tokens 5 / completion_tokens 3 / total_tokens 8.
    expect(row.inputTokens).toBe(5);
    expect(row.outputTokens).toBe(3);
    expect(row.totalTokens).toBe(8);
    expect(row.inputTokens + row.outputTokens).toBeGreaterThan(0);

    const attempt = db.select().from(sch.requestAttempts).where(eq(sch.requestAttempts.requestId, row.id)).all().at(-1)!;
    expect(attempt.inputTokens).toBe(5);
    expect(attempt.outputTokens).toBe(3);
  });

  it('records the same usage when the answer streams', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');

    const res = await chat('qoder/qmodel_38max', true);
    expect(res.status).toBe(200);
    await res.text();

    const row = db.select().from(sch.requests).all().filter((r) => r.requestedModel === 'qoder/qmodel_38max' && r.streaming).at(-1)!;
    // Streaming parity is the case that stayed at 0 in production (128 of 128 requests).
    expect(row.inputTokens).toBe(5);
    expect(row.outputTokens).toBe(3);
  });

  it('fails the request when every account is down', async () => {
    const { setQoderAccountHealth } = await import('../../src/server/db/repositories/qoder-accounts');
    setQoderAccountHealth(healthyAccountId, 'down', 'personal access token rejected — replace it');
    const callsBefore = qoderCalls;
    try {
      const res = await chat('qoder/qmodel_38max');
      expect(res.status).not.toBe(200);
      const body = await res.json() as { error: { code?: string; message: string } };
      expect(body.error.message).toMatch(/no enabled Qoder account/i);
      // No upstream call is made once the pool is empty.
      expect(qoderCalls).toBe(callsBefore);
    } finally {
      setQoderAccountHealth(healthyAccountId, 'healthy');
    }
  });
});
