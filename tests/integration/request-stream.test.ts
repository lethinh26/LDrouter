// Integration tests: /api/admin/requests/stream (SSE) for real-time request notifications.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq, inArray } from 'drizzle-orm';

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
async function readStreamEvents(
  since: number | string,
  want: number,
  timeoutMs = 4000,
  onConnected?: () => void | Promise<void>,
  afterId?: string,
): Promise<string[]> {
  const params = new URLSearchParams({ since: String(since) });
  if (afterId) params.set('afterId', afterId);
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/admin/requests/stream?${params.toString()}`, {
    headers: { cookie: csrfCookies },
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`stream status ${res.status}`);
  const reader = res.body!.getReader();
  await onConnected?.();
  const decoder = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    while (events.length < want) {
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
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  if (timedOut && events.length < want) throw new Error(`Timed out after ${events.length}/${want} SSE events`);
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

  it('replays more than one page of missed request completions without truncation', async () => {
    const { getDb, schema } = await import('../../src/server/db/index');
    const { emitRequestLogged } = await import('../../src/server/gateway/events');
    const db = getDb();
    const since = Date.now() + 60_000;
    const createdAt = new Date(since + 1000).toISOString();
    const rows = Array.from({ length: 125 }, (_, index) => ({
      id: `req-replay-page-${String(index).padStart(2, '0')}`,
      createdAt,
      completedAt: createdAt,
      clientIp: '127.0.0.1',
      protocol: 'openai' as const,
      endpoint: 'chat/completions',
      requestedModel: 'mock/gpt-mock',
      resolvedTargetKind: 'model' as const,
      streaming: false,
      httpStatus: 200,
      success: true,
    }));
    const liveRow = {
      id: 'req-replay-live-during-backlog',
      createdAt: new Date(since + 2000).toISOString(),
      completedAt: new Date(since + 2000).toISOString(),
      clientIp: '127.0.0.1',
      protocol: 'openai' as const,
      endpoint: 'chat/completions',
      requestedModel: 'mock/gpt-mock',
      resolvedTargetKind: 'model' as const,
      streaming: false,
      httpStatus: 200,
      success: true,
    };
    db.insert(schema.requests).values(rows).run();

    try {
      const events = await readStreamEvents(since, rows.length + 1, 8000, () => {
        db.insert(schema.requests).values(liveRow).run();
        emitRequestLogged(liveRow.id);
      });
      const replayedIds = events.map((event) => (JSON.parse(event) as { id: string }).id);

      expect(replayedIds).toHaveLength(rows.length + 1);
      expect(replayedIds).toEqual([...rows.map((row) => row.id).sort(), liveRow.id]);
    } finally {
      for (const row of rows) db.delete(schema.requests).where(eq(schema.requests.id, row.id)).run();
      db.delete(schema.requests).where(eq(schema.requests.id, liveRow.id)).run();
    }
  });

  it('continues a capped replay without flushing a newer live completion past unseen history', async () => {
    const { getDb, schema } = await import('../../src/server/db/index');
    const { emitRequestLogged } = await import('../../src/server/gateway/events');
    const db = getDb();
    const since = Date.now() + 120_000;
    const createdAt = new Date(since + 1000).toISOString();
    const rows = Array.from({ length: 10_005 }, (_, index) => ({
      id: `req-cap-${String(index).padStart(5, '0')}`,
      createdAt,
      completedAt: createdAt,
      clientIp: '127.0.0.1',
      protocol: 'openai' as const,
      endpoint: 'chat/completions',
      requestedModel: 'mock/gpt-mock',
      resolvedTargetKind: 'model' as const,
      streaming: false,
      httpStatus: 200,
      success: true,
    }));
    const liveRow = {
      id: 'req-cap-live-newer',
      createdAt: new Date(since + 2000).toISOString(),
      completedAt: new Date(since + 2000).toISOString(),
      clientIp: '127.0.0.1',
      protocol: 'openai' as const,
      endpoint: 'chat/completions',
      requestedModel: 'mock/gpt-mock',
      resolvedTargetKind: 'model' as const,
      streaming: false,
      httpStatus: 200,
      success: true,
    };

    for (let index = 0; index < rows.length; index += 100) {
      db.insert(schema.requests).values(rows.slice(index, index + 100)).run();
    }

    try {
      // Ask for one more event than the per-connection cap; the server must
      // close cleanly after 10k rows instead of flushing this newer live row.
      const firstPage = await readStreamEvents(since, 10_001, 20_000, () => {
        db.insert(schema.requests).values(liveRow).run();
        emitRequestLogged(liveRow.id);
      });
      expect(firstPage).toHaveLength(10_000);
      const firstIds = firstPage.map((event) => (JSON.parse(event) as { id: string }).id);
      expect(firstIds).toEqual(rows.slice(0, 10_000).map((row) => row.id));

      const last = JSON.parse(firstPage[firstPage.length - 1]!) as { id: string; createdAt: string };
      const continuation = await readStreamEvents(last.createdAt, 6, 12_000, undefined, last.id);
      const continuationIds = continuation.map((event) => (JSON.parse(event) as { id: string }).id);
      expect(continuationIds).toEqual([...rows.slice(10_000).map((row) => row.id), liveRow.id]);
    } finally {
      db.delete(schema.requests).where(inArray(schema.requests.id, [...rows.map((row) => row.id), liveRow.id])).run();
    }
  });

  it('closes on live-completion queue overflow and recovers all persisted rows by replay cursor', async () => {
    const { getDb, schema } = await import('../../src/server/db/index');
    const { emitRequestLogged, getRequestEventListenerCounts } = await import('../../src/server/gateway/events');
    const { setRequestStreamReplayTestGateForTests } = await import('../../src/server/routes/admin/requests');
    const db = getDb();
    const since = Date.now() + 120_000;
    const backlogAt = new Date(since + 1000).toISOString();
    const backlog = Array.from({ length: 5000 }, (_, index) => ({
      id: `req-overflow-backlog-${String(index).padStart(5, '0')}`,
      createdAt: backlogAt,
      completedAt: backlogAt,
      clientIp: '127.0.0.1',
      protocol: 'openai' as const,
      endpoint: 'chat/completions',
      requestedModel: 'mock/gpt-mock',
      resolvedTargetKind: 'model' as const,
      streaming: false,
      httpStatus: 200,
      success: true,
    }));
    const liveRows = Array.from({ length: 101 }, (_, index) => {
      const createdAt = new Date(since + 2000 + index).toISOString();
      return {
        id: `req-overflow-live-${String(index).padStart(5, '0')}`,
        createdAt,
        completedAt: createdAt,
        clientIp: '127.0.0.1',
        protocol: 'openai' as const,
        endpoint: 'chat/completions',
        requestedModel: 'mock/gpt-mock',
        resolvedTargetKind: 'model' as const,
        streaming: false,
        httpStatus: 200,
        success: true,
      };
    });
    const allRows = [...backlog, ...liveRows];
    for (let index = 0; index < backlog.length; index += 100) {
      db.insert(schema.requests).values(backlog.slice(index, index + 100)).run();
    }
    const cleanupDeadline = Date.now() + 2000;
    while (Date.now() < cleanupDeadline) {
      const counts = getRequestEventListenerCounts();
      if (counts.requestLogged === 0 && counts.requestStarted === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(getRequestEventListenerCounts()).toEqual({ requestLogged: 0, requestStarted: 0 });
    const listenerBaseline = getRequestEventListenerCounts();
    let releaseReplay!: () => void;
    let signalReplayPaused!: () => void;
    const replayPaused = new Promise<void>((resolve) => { signalReplayPaused = resolve; });
    const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve; });
    setRequestStreamReplayTestGateForTests(async () => {
      signalReplayPaused();
      await replayGate;
    });

    try {
      const overflowFrames = await readStreamEvents(since, 10_001, 20_000, async () => {
        // The server has emitted its first replay page and is now blocked in
        // replay. Do not rely on timing or backlog size alone.
        await replayPaused;
        expect(getRequestEventListenerCounts().requestLogged).toBe(listenerBaseline.requestLogged + 1);
        for (let index = 0; index < liveRows.length; index += 100) {
          const chunk = liveRows.slice(index, index + 100);
          db.insert(schema.requests).values(chunk).run();
          for (const row of chunk) emitRequestLogged(row.id);
        }
      });
      // Exactly one replay page is delivered. The 101st live completion closes
      // the stream before more history or queued live rows can advance its cursor.
      expect(overflowFrames).toHaveLength(100);
      releaseReplay();
      setRequestStreamReplayTestGateForTests(null);
      const overflowCleanupDeadline = Date.now() + 2000;
      while (Date.now() < overflowCleanupDeadline) {
        const counts = getRequestEventListenerCounts();
        if (counts.requestLogged === 0 && counts.requestStarted === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(getRequestEventListenerCounts()).toEqual({ requestLogged: 0, requestStarted: 0 });

      const replay = await readStreamEvents(since, allRows.length, 20_000);
      const replayedIds = replay
        .map((event) => (JSON.parse(event) as { id: string }).id);
      expect(replayedIds).toEqual(allRows.map((row) => row.id));
    } finally {
      releaseReplay();
      setRequestStreamReplayTestGateForTests(null);
      for (let index = 0; index < allRows.length; index += 500) {
        db.delete(schema.requests).where(inArray(schema.requests.id, allRows.slice(index, index + 500).map((row) => row.id))).run();
      }
    }
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

  it('falls back safely for malformed replay cursors', async () => {
    for (const since of ['Infinity', '1.5', '0x10', '99999999999999999']) {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/admin/requests/stream?since=${since}&afterId=ignored`, {
        headers: { cookie: csrfCookies },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
    }
  });

  it('removes both event-bus listeners when a client aborts an established stream', async () => {
    const { getRequestEventListenerCounts } = await import('../../src/server/gateway/events');
    const waitForCounts = async (expected: { requestLogged: number; requestStarted: number }): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const counts = getRequestEventListenerCounts();
        if (counts.requestLogged === expected.requestLogged && counts.requestStarted === expected.requestStarted) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(getRequestEventListenerCounts()).toEqual(expected);
    };
    // Prior tests abort their streams; wait for their asynchronous server-side
    // close handlers before measuring this connection's listener delta.
    await waitForCounts({ requestLogged: 0, requestStarted: 0 });
    const before = getRequestEventListenerCounts();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/admin/requests/stream?since=${Date.now() + 60_000}`, {
      headers: { cookie: csrfCookies },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const connected = {
      requestLogged: before.requestLogged + 1,
      requestStarted: before.requestStarted + 1,
    };
    await waitForCounts(connected);

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    await waitForCounts(before);
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

  it('rechecks block/allow IP policy, session expiry, and session revocation on established SSE streams', async () => {
    const { getDb, schema } = await import('../../src/server/db/index');
    const { updateSettings } = await import('../../src/server/db/repositories/settings');
    const { sha256Hex } = await import('../../src/server/auth/ids');
    const openStream = async () => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/admin/requests/stream?since=${Date.now() + 60_000}`, {
        headers: { cookie: csrfCookies },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      return { controller, reader: response.body!.getReader() };
    };
    const expectStreamClosed = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
      const closed = await Promise.race([
        reader.read().then(({ done }) => done).catch(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 7000)),
      ]);
      expect(closed).toBe(true);
    };

    const ipStream = await openStream();
    updateSettings({ adminIpBlock: '127.0.0.1/32' });
    await expectStreamClosed(ipStream.reader);
    ipStream.controller.abort();
    updateSettings({ adminIpBlock: null });

    const allowStream = await openStream();
    updateSettings({ adminIpAllow: '10.0.0.0/8' });
    await expectStreamClosed(allowStream.reader);
    allowStream.controller.abort();
    updateSettings({ adminIpAllow: null });

    const sessionStream = await openStream();
    const sessionToken = csrfCookies.split(';')[0]!.slice('ld_session='.length);
    const sessionDigest = sha256Hex(sessionToken);
    const session = getDb().select().from(schema.adminSessions).all()
      .find((row) => row.tokenDigest === sessionDigest);
    expect(session).toBeTruthy();
    getDb().update(schema.adminSessions)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schema.adminSessions.id, session!.id)).run();
    await expectStreamClosed(sessionStream.reader);
    sessionStream.controller.abort();

    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(login.status).toBe(200);
    csrfCookies = login.headers.get('set-cookie') ?? '';

    const revokedStream = await openStream();
    const replacementToken = csrfCookies.split(';')[0]!.slice('ld_session='.length);
    const replacementDigest = sha256Hex(replacementToken);
    const replacementSession = getDb().select().from(schema.adminSessions).all()
      .find((row) => row.tokenDigest === replacementDigest);
    expect(replacementSession).toBeTruthy();
    getDb().delete(schema.adminSessions).where(eq(schema.adminSessions.id, replacementSession!.id)).run();
    await expectStreamClosed(revokedStream.reader);
    revokedStream.controller.abort();

    const finalLogin = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(finalLogin.status).toBe(200);
    csrfCookies = finalLogin.headers.get('set-cookie') ?? '';
  });
});
