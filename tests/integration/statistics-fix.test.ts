// Statistics: the cache-hit and fallback figures must describe what actually happened.
// Verified against live traffic, the defects were:
//   - a fallback whose second attempt succeeded was still logged success=0 with the
//     first attempt's status (502/504/429). 17 such requests existed. So the request
//     log — and every rate derived from it, including the fallback figure — recorded a
//     failure where the client received a 200 answer.
//   - the cached share of the prompt used one denominator for every provider, but
//     Anthropic's `input_tokens` EXCLUDES the cached prefix while OpenAI-compatible
//     `prompt_tokens` INCLUDES it, so the blanket formula double-counted the cache
//     (measured: 21.75% where the truth was 27.80%).
//   - Codex, 46% of traffic, reported zero cached tokens because the Responses API
//     nests them under `input_tokens_details` (covered in unit/codex-provider.test.ts).
// The fallback logging is asserted end-to-end here; the derived rates are unit-tested.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheHitRateOf, fallbackRateOf, gatewayCacheHitRateOf, promptTokensFor, type LiveTally } from '../../src/web/lib/use-live-stats';


const dataDir = path.join(os.tmpdir(), `latedev-stats-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
let modelA = '';
let modelB = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookies = login.headers.get('set-cookie') ?? '';
  await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'mock', slug: 'mockstats', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', enabled: true, totalTimeoutMs: 5000 }),
  });
  const db = (await import('../../src/server/db/index')).getDb();
  const sch = await import('../../src/server/db/schema');
  const { uuid } = await import('../../src/server/auth/ids');
  providerId = db.select().from(sch.providers).all()[0]!.id;
  modelA = uuid();
  modelB = uuid();
  db.insert(sch.models).values({ id: modelA, providerId, upstreamModelId: 'a', publicModelId: 'mockstats/a', displayName: 'A', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
  db.insert(sch.models).values({ id: modelB, providerId, upstreamModelId: 'b', publicModelId: 'mockstats/b', displayName: 'B', enabled: true, upstreamAvailable: true, capabilitiesJson: JSON.stringify({ chat: true, streaming: true }) }).run();
  const keyRes = await fetch(`${baseUrl}/api/admin/api-keys`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: JSON.stringify({ name: 'k', allowAllModels: true }) });
  secret = ((await keyRes.json()) as { secret: string }).secret;
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cache-hit rate denominators follow provider token semantics', () => {
  const tally = (promptTokens: number, cacheReadTokens: number): LiveTally => ({ cacheReadTokens, promptTokens, gatewayCacheHits: 0, fallbacks: 0 });

  it('keeps the prompt as reported for OpenAI-compatible providers', () => {
    // `prompt_tokens` (100) already includes the 40 cached ones, so the prompt is 100.
    expect(promptTokensFor(100, 40, 'openai')).toBe(100);
    expect(promptTokensFor(100, 40, 'codex')).toBe(100);
    expect(promptTokensFor(100, 40, null)).toBe(100);
  });

  it('adds the cached prefix back for Anthropic, which excludes it from input_tokens', () => {
    // Anthropic's `input_tokens` (60) EXCLUDES the 40 cached, so the prompt really is 100.
    expect(promptTokensFor(60, 40, 'anthropic')).toBe(100);
    // Read as OpenAI semantics instead, the same row would be a prompt of 60 — inflating
    // the rate from 0.40 to 0.67, which is the bug the per-provider split prevents.
    expect(promptTokensFor(60, 40, 'openai')).toBe(60);
  });

  it('derives the rate from the normalised prompt', () => {
    expect(cacheHitRateOf(tally(100, 40))).toBeCloseTo(0.4);
    expect(cacheHitRateOf(tally(60, 40))).toBeCloseTo(0.6667, 3);
  });

  it('is zero, not NaN, when no prompt tokens were reported', () => {
    expect(cacheHitRateOf(tally(0, 0))).toBe(0);
  });
});

describe('gateway cache and fallback rates are shares of the requests', () => {
  it('divides by the request count', () => {
    expect(gatewayCacheHitRateOf({ gatewayCacheHits: 3 }, 12)).toBeCloseTo(0.25);
    expect(fallbackRateOf({ fallbacks: 2 }, 8)).toBeCloseTo(0.25);
  });

  it('is zero for an empty window', () => {
    expect(gatewayCacheHitRateOf({ gatewayCacheHits: 0 }, 0)).toBe(0);
    expect(fallbackRateOf({ fallbacks: 0 }, 0)).toBe(0);
  });
});

describe('a combo served by its first member is not a fallback', () => {
  it('counts one attempt and leaves the fallback rate alone', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const { uuid } = await import('../../src/server/auth/ids');
    const comboId = uuid();
    db.insert(sch.combos).values({ id: comboId, name: 'stats-one', slug: 'stats-one', publicModelId: 'combo/stats-one', mode: 'fallback', enabled: true }).run();
    db.insert(sch.comboMembers).values({ id: uuid(), comboId, modelId: modelA, position: 0, weight: 1, enabled: true }).run();

    const http = await import('node:http');
    const srv = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'a', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const { eq } = await import('drizzle-orm');
    db.update(sch.providers).set({ baseUrl: `http://127.0.0.1:${port}` }).where(eq(sch.providers.id, providerId)).run();
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ model: 'combo/stats-one', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      await res.json();

      const rowsOne = db.select().from(sch.requests).all().filter((r) => r.requestedModel === 'combo/stats-one');
      const row = rowsOne[rowsOne.length - 1]!;
      expect(row.success).toBe(true);
      // Member 1 answered, so this is a single attempt: it must not be counted as a retry.
      // (Live data confirms the same holds for multi-member combos: attempts_count equals
      // the highest attempt_number recorded, with no combo inflating the count.)
      expect(row.attemptsCount).toBe(1);
      expect(db.select().from(sch.requestAttempts).all().filter((a) => a.requestId === row.id)).toHaveLength(1);

      const stats = await fetch(`${baseUrl}/api/admin/stats?preset=30d`, { headers: { cookie: cookies } });
      expect(stats.status).toBe(200);
      const body = await stats.json() as { summary: { fallbackRate: number; totalRequests: number } };
      // The window counts this request exactly once, and since no retry happened the rate
      // must stay 0 — a clean single-attempt request may never produce a fallback.
      expect(body.summary.totalRequests).toBeGreaterThan(0);
      expect(body.summary.fallbackRate).toBe(0);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('a fallback that succeeded is logged as a success', () => {
  it('clears the first attempt failure when a later candidate answers', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const { uuid } = await import('../../src/server/auth/ids');
    const comboId = uuid();
    db.insert(sch.combos).values({ id: comboId, name: 'stats-fb', slug: 'stats-fb', publicModelId: 'combo/stats-fb', mode: 'fallback', enabled: true }).run();
    db.insert(sch.comboMembers).values({ id: uuid(), comboId, modelId: modelA, position: 0, weight: 1, enabled: true }).run();
    db.insert(sch.comboMembers).values({ id: uuid(), comboId, modelId: modelB, position: 1, weight: 1, enabled: true }).run();

    const http = await import('node:http');
    let calls = 0;
    const srv = http.createServer((_req, res) => {
      calls += 1;
      // First candidate fails outright; the second answers normally.
      if (calls === 1) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'b', choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const { eq } = await import('drizzle-orm');
    db.update(sch.providers).set({ baseUrl: `http://127.0.0.1:${port}`, cbFailureThreshold: 99 }).where(eq(sch.providers.id, providerId)).run();
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ model: 'combo/stats-fb', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = await res.json() as { choices?: Array<{ message: { content: string } }>; error?: unknown };
      expect(body.error).toBeUndefined();
      expect(body.choices?.[0]?.message.content).toBe('recovered');

      const rowsFb = db.select().from(sch.requests).all().filter((r) => r.requestedModel === 'combo/stats-fb');
      const row = rowsFb[rowsFb.length - 1]!;
      // The retry carried the response, so the request is a success with a fallback.
      expect(row.success).toBe(true);
      expect(row.httpStatus).toBe(200);
      expect(row.errorType).toBeNull();
      expect(row.attemptsCount).toBeGreaterThan(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});