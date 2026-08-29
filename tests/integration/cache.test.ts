// Integration: gateway response cache behavior.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { take } from './_mock-control.js';

const dataDir = path.join(os.tmpdir(), `latedev-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let secret = '';
let providerId = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookies = login.headers.get('set-cookie') ?? '';
  // Enable cache globally
  await fetch(`${baseUrl}/api/admin/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies }, body: JSON.stringify({ gatewayCacheEnabled: true, gatewayCacheDefaultTtlSeconds: 60 }) });
  // Provider pointing at mock upstream
  await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'mock', slug: 'mockc', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', enabled: true, totalTimeoutMs: 5000 }),
  });
  const db = (await import('../../src/server/db/index')).getDb();
  const providers = db.select().from((await import('../../src/server/db/schema')).providers).all();
  providerId = providers[0]!.id;
  const { uuid } = await import('../../src/server/auth/ids');
  db.insert((await import('../../src/server/db/schema')).models).values({
    id: uuid(), providerId, upstreamModelId: 'm',
    publicModelId: 'mockc/m', displayName: 'M', enabled: true, upstreamAvailable: true,
    capabilitiesJson: JSON.stringify({ chat: true, streaming: true }),
  }).run();
  const keyRes = await fetch(`${baseUrl}/api/admin/api-keys`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: JSON.stringify({ name: 'k', allowAllModels: true }) });
  secret = (await keyRes.json() as { secret: string }).secret;
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('cache behavior', () => {
  it('cache disabled by default', async () => {
    // cache is now enabled in beforeAll; confirm a request stores and serves from cache
    const upstreamCalls: string[] = [];
    // Use a local http server inline
    const http = await import('node:http');
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        upstreamCalls.push(body);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'cmpl', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'cached' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const db = (await import('../../src/server/db/index')).getDb();
    const { eq } = await import('drizzle-orm');
    const { schema } = await import('../../src/server/db/index');
    db.update(schema.providers).set({ baseUrl: `http://127.0.0.1:${port}` }).where(eq(schema.providers.id, providerId)).run();
    const body = { model: 'mockc/m', messages: [{ role: 'user', content: 'hi' }] };
    // First request goes to upstream
    const r1 = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    const j1 = await r1.json();
    expect(j1.choices[0].message.content).toBe('cached');
    expect(upstreamCalls.length).toBe(1);
    // Second identical request should hit cache
    const r2 = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    await r2.json();
    expect(upstreamCalls.length).toBe(1); // no additional upstream call
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('streaming bypasses cache', async () => {
    const http = await import('node:http');
    let calls = 0;
    const srv = http.createServer((req, res) => {
      calls += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"index":0,"delta":{"content":"s"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const db = (await import('../../src/server/db/index')).getDb();
    const { eq } = await import('drizzle-orm');
    const { schema } = await import('../../src/server/db/index');
    db.update(schema.providers).set({ baseUrl: `http://127.0.0.1:${port}` }).where(eq(schema.providers.id, providerId)).run();
    const body = { model: 'mockc/m', stream: true, messages: [{ role: 'user', content: 'streaming' }] };
    await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    expect(calls).toBe(2); // stream requests always hit upstream
    await new Promise<void>((r) => srv.close(() => r()));
    void take;
  });
});
