// Integration: admin model test endpoint (POST /api/admin/models/:id/test).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-mtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

// Mock upstream (OpenAI-compatible) the gateway calls.
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
let cookies = '';
let modelId = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await startMockUpstream();

  await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  cookies = loginRes.headers.get('set-cookie') ?? '';

  await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({
      name: 'mock', slug: 'mock', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'sk-mock', enabled: true, totalTimeoutMs: 5000, firstTokenTimeoutMs: 5000,
    }),
  });
  const db = (await import('../../src/server/db/index')).getDb();
  const { uuid } = await import('../../src/server/auth/ids');
  const schema = await import('../../src/server/db/schema');
  const provider = db.select().from(schema.providers).all().find((p) => p.slug === 'mock')!;
  modelId = uuid();
  db.insert(schema.models).values({
    id: modelId, providerId: provider.id, upstreamModelId: 'gpt-mock',
    publicModelId: 'mock/gpt-mock', displayName: 'GPT Mock', enabled: true, upstreamAvailable: true,
    capabilitiesJson: JSON.stringify({ chat: true, streaming: true }),
  }).run();
});

beforeEach(async () => {
  const { reset } = await import('./_mock-control.js');
  reset();
});

afterAll(async () => {
  if (mockUpstream) mockUpstream.close();
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('model test endpoint', () => {
  it('returns TTFT, latency, usage and response text', async () => {
    const { pushHandler } = await import('./_mock-control.js');
    pushHandler((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'gpt-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Tôi là mock model.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
      }));
    });

    const res = await fetch(`${baseUrl}/api/admin/models/${modelId}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: '{}',
    });
    expect(res.status).toBe(200);
    const r = await res.json() as {
      success: boolean; text: string; latencyMs: number; ttftMs: number | null;
      usage: { input: number; output: number; total: number };
      attempts: Array<{ success: boolean; failureReason: string | null }>;
    };
    expect(r.success).toBe(true);
    expect(r.text).toBe('Tôi là mock model.');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.ttftMs).toBeGreaterThanOrEqual(0);
    expect(r.usage.input).toBe(10);
    expect(r.usage.output).toBe(7);
    expect(r.usage.total).toBe(17);
    expect(r.attempts.length).toBe(1);
    expect(r.attempts[0]!.success).toBe(true);
  });

  it('reports failure without crashing when upstream errors', async () => {
    const { pushHandler } = await import('./_mock-control.js');
    pushHandler((_req, res) => {
      res.statusCode = 429;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    const res = await fetch(`${baseUrl}/api/admin/models/${modelId}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: '{}',
    });
    expect(res.status).toBe(200);
    const r = await res.json() as { success: boolean; text: string | null; attempts: Array<{ success: boolean; failureReason: string | null }> };
    expect(r.success).toBe(false);
    expect(r.attempts[0]!.success).toBe(false);
    expect(r.attempts[0]!.failureReason).toBeTruthy();
  });

  it('sends the default Vietnamese test prompt', async () => {
    const { pushHandler } = await import('./_mock-control.js');
    let seenBody = '';
    pushHandler((req, res, body) => {
      seenBody = body;
      void req;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'gpt-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    await fetch(`${baseUrl}/api/admin/models/${modelId}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: '{}',
    });
    expect(seenBody).toContain('Bạn là model gì?');
  });
});
