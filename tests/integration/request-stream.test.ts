// Integration tests: /api/admin/requests/stream (SSE) for real-time request notifications.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-reqstream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

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
let apiKeySecret = '';

// Reads SSE frames from the stream endpoint until `want` events arrived (or timeout), then aborts.
async function readStreamEvents(since: number, want: number, timeoutMs = 4000): Promise<string[]> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/admin/requests/stream?since=${since}`, {
    headers: { cookie: csrfCookies },
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`stream status ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) events.push(line.slice(6));
      }
      if (events.length >= want) break;
    }
    if (events.length >= want) break;
  }
  controller.abort();
  return events;
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await startMockUpstream();

  // Setup and login
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

  // Provider + model
  const provRes = await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: csrfCookies },
    body: JSON.stringify({
      name: 'mock', slug: 'mock', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'sk-mock', enabled: true, totalTimeoutMs: 5000, firstTokenTimeoutMs: 5000,
    }),
  });
  if (!provRes.ok) throw new Error(`provider ${provRes.status} ${await provRes.text()}`);
  const db = (await import('../../src/server/db/index')).getDb();
  const { uuid } = await import('../../src/server/auth/ids');
  const providers = db.select().from((await import('../../src/server/db/schema')).providers).all();
  const provider = providers.find((p) => p.slug === 'mock')!;
  db.insert((await import('../../src/server/db/schema')).models).values({
    id: uuid(), providerId: provider.id, upstreamModelId: 'gpt-mock',
    publicModelId: 'mock/gpt-mock', displayName: 'GPT Mock', enabled: true, upstreamAvailable: true,
    capabilitiesJson: JSON.stringify({ chat: true, streaming: true, tools: true }),
  }).run();

  // API key
  const keyRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: csrfCookies },
    body: JSON.stringify({ name: 'test-key', allowAllModels: true }),
  });
  if (!keyRes.ok) throw new Error(`key ${keyRes.status}`);
  apiKeySecret = ((await keyRes.json()) as { secret: string }).secret;
});

afterAll(async () => {
  if (app) await app.close();
  if (mockUpstream) await new Promise<void>((r) => mockUpstream!.close(() => r()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('/api/admin/requests/stream', () => {
  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/admin/requests/stream?since=0`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe('authentication_error');
  });

  it('replays history when connecting with since=0', async () => {
    const { reset, pushHandler } = await import('./_mock-control.js');
    reset();
    pushHandler((_req: unknown, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: string) => {
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe('gpt-mock');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'cmpl-x', object: 'chat.completion', created: 0, model: 'gpt-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'history' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
    });

    // Make a gateway request — persistRequest runs before the client response resolves.
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKeySecret}` },
      body: JSON.stringify({ model: 'mock/gpt-mock', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);

    const events = await readStreamEvents(0, 1);
    const summary = JSON.parse(events[events.length - 1]!) as {
      success: boolean; requestedModel: string; inputTokens: number; outputTokens: number; httpStatus: number;
    };
    expect(summary.success).toBe(true);
    expect(summary.requestedModel).toBe('mock/gpt-mock');
    expect(summary.inputTokens).toBe(2);
    expect(summary.outputTokens).toBe(1);
  });

  it('emits live events for requests after the stream opened', async () => {
    const { reset, pushHandler } = await import('./_mock-control.js');
    reset();
    pushHandler((_req: unknown, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: string) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'cmpl-live', object: 'chat.completion', created: 0, model: 'gpt-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'live' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      void body;
    });

    // Open the stream first (no history expected), then trigger a request.
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/admin/requests/stream?since=${Date.now()}`, {
      headers: { cookie: csrfCookies },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let eventData: string | null = null;
    const deadline = Date.now() + 4000;

    const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKeySecret}` },
      body: JSON.stringify({ model: 'mock/gpt-mock', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(chat.status).toBe(200);

    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf('\n\n');
      if (idx !== -1) {
        const frame = buf.slice(0, idx);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) eventData = line.slice(6);
        }
        break;
      }
    }
    controller.abort();

    expect(eventData).toBeTruthy();
    const summary = JSON.parse(eventData!) as { success: boolean; inputTokens: number; requestedModel: string };
    expect(summary.success).toBe(true);
    expect(summary.inputTokens).toBe(1);
    expect(summary.requestedModel).toBe('mock/gpt-mock');
  });

  it('persists notification preferences (default on, toggle round-trip)', async () => {
    interface SettingsShape { notificationsEnabled: boolean; notificationSoundEnabled: boolean }

    // Defaults: both enabled.
    const get0 = await fetch(`${baseUrl}/api/admin/settings`, { headers: { cookie: csrfCookies } });
    expect(get0.status).toBe(200);
    const s0 = ((await get0.json()) as { settings: SettingsShape }).settings;
    expect(s0.notificationsEnabled).toBe(true);
    expect(s0.notificationSoundEnabled).toBe(true);

    // Toggle both off.
    const patch = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: csrfCookies },
      body: JSON.stringify({ notificationsEnabled: false, notificationSoundEnabled: false }),
    });
    expect(patch.status).toBe(200);
    const get1 = await fetch(`${baseUrl}/api/admin/settings`, { headers: { cookie: csrfCookies } });
    const s1 = ((await get1.json()) as { settings: SettingsShape }).settings;
    expect(s1.notificationsEnabled).toBe(false);
    expect(s1.notificationSoundEnabled).toBe(false);

    // Back on.
    const patch2 = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: csrfCookies },
      body: JSON.stringify({ notificationsEnabled: true, notificationSoundEnabled: true }),
    });
    expect(patch2.status).toBe(200);
    const get2 = await fetch(`${baseUrl}/api/admin/settings`, { headers: { cookie: csrfCookies } });
    const s2 = ((await get2.json()) as { settings: SettingsShape }).settings;
    expect(s2.notificationsEnabled).toBe(true);
    expect(s2.notificationSoundEnabled).toBe(true);
  });
});
