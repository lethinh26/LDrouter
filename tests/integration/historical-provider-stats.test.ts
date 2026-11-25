import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceLiveTally, cacheHitRateOf, EMPTY_TALLY, type LiveRequestShape, type StatsSnapshot } from '../../src/web/lib/use-live-stats';
import type { AttemptLog, RequestLogSummary } from '../../src/shared/types';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-history-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookie = '';
const missingProvider = 'removed-provider-id';
const missingModel = 'removed-model-id';
const activeProvider = 'active-provider-id';
const activeModel = 'active-model-id';
const modelOnlyDeleted = 'removed-model-with-live-provider';
const rawDay = '2026-01-10';
const compactedDay = '2026-01-11';
const knownDay = '2026-01-12';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const setup = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  expect(setup.ok).toBe(true);
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  expect(login.ok).toBe(true);
  cookie = login.headers.get('set-cookie') ?? '';
  const { getDb, schema } = await import('../../src/server/db');
  const db = getDb();
  db.insert(schema.providers).values({ id: activeProvider, name: 'Current provider', slug: 'current', type: 'anthropic', baseUrl: 'http://127.0.0.1:9' }).run();
  db.insert(schema.models).values({ id: activeModel, providerId: activeProvider, publicModelId: 'current/model', upstreamModelId: 'model', displayName: 'Current model' }).run();
  const request = (id: string, day: string, finalModelId: string, inputTokens: number, cacheReadTokens: number, attemptsCount = 1) => {
    db.insert(schema.requests).values({
      id, createdAt: `${day}T12:00:00.000Z`, clientIp: '127.0.0.1', protocol: 'openai', endpoint: '/v1/chat/completions',
      requestedModel: 'combo/example', resolvedTargetKind: 'combo', resolvedTargetId: 'combo-id',
      finalModelId, streaming: false, httpStatus: 200, success: true, totalLatencyMs: 100,
      inputTokens, cacheReadTokens, outputTokens: 10, totalTokens: inputTokens + 10, attemptsCount,
    }).run();
  };
  const attempt = (requestId: string, day: string, providerId: string, modelId: string, attemptNumber: number, success: boolean, latencyMs: number) => {
    db.insert(schema.requestAttempts).values({
      id: `${requestId}-attempt-${attemptNumber}`, requestId, providerId, modelId, attemptNumber,
      startedAt: `${day}T12:00:00.000Z`, success, latencyMs, selectionReason: 'combo',
    }).run();
  };
  request('historical-raw', rawDay, missingModel, 100, 40, 2);
  attempt('historical-raw', rawDay, activeProvider, activeModel, 1, false, 50);
  attempt('historical-raw', rawDay, missingProvider, missingModel, 2, true, 100);
  request('active-raw', rawDay, activeModel, 60, 40);
  attempt('active-raw', rawDay, activeProvider, activeModel, 1, true, 200);
  // A pruned day has a partial raw tail; its aggregate already includes that tail.
  request('retained-tail', compactedDay, missingModel, 20, 0);
  attempt('retained-tail', compactedDay, missingProvider, missingModel, 1, true, 100);
  db.insert(schema.dailyModelStats).values({ day: compactedDay, modelId: missingModel, requests: 3, successfulRequests: 2, failedRequests: 1, inputTokens: 60, outputTokens: 30, latencySuccessSumMs: 500, latencySuccessCount: 2 }).run();
  db.insert(schema.dailyProviderStats).values({ day: compactedDay, providerId: missingProvider, attempts: 4, successfulAttempts: 3, failedAttempts: 1, latencySuccessSumMs: 600, latencySuccessCount: 3 }).run();
  // The model is gone but its provider survives, so the token convention is recoverable.
  request('model-only-deleted', knownDay, modelOnlyDeleted, 60, 40);
  attempt('model-only-deleted', knownDay, activeProvider, modelOnlyDeleted, 1, true, 100);
  request('cache-only-deleted', knownDay, missingModel, 0, 0, 0);
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
});

async function get<T>(route: string): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

function stats(fromDay: string, toDay = fromDay) {
  const q = new URLSearchParams({ from: `${fromDay}T00:00:00.000Z`, to: `${toDay}T23:59:59.999Z` });
  return get<StatsSnapshot>(`/api/admin/stats?${q}`);
}

describe('historical identifiers after deleting provider/model configuration', () => {
  it('shows the final historical model and provider in list and detail; keeps the live first attempt distinct', async () => {
    const list = await get<{ requests: RequestLogSummary[] }>('/api/admin/requests?id=historical-raw');
    const historical = {
      finalModelPublicId: `Deleted model (${missingModel})`, finalModelUpstreamId: null, finalModelDeleted: true,
      providerId: missingProvider, providerName: `Deleted provider (${missingProvider})`, providerDeleted: true, providerSlug: null, providerType: null,
    };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject(historical);
    const detail = await get<{ request: RequestLogSummary; attempts: AttemptLog[] }>('/api/admin/requests/historical-raw');
    expect(detail.request).toMatchObject(historical);
    expect(detail.attempts).toHaveLength(2);
    expect(detail.attempts[0]).toMatchObject({ providerId: activeProvider, providerName: 'Current provider', modelPublicId: 'current/model', upstreamModelId: 'model' });
    expect(detail.attempts[1]).toMatchObject({ providerId: missingProvider, modelId: missingModel, providerName: historical.providerName, modelPublicId: historical.finalModelPublicId, upstreamModelId: '' });
    expect(detail.attempts[1]).not.toHaveProperty('codexAccountId');
    expect(detail.attempts[1]).not.toHaveProperty('qoderAccountId');
  });

  it('preserves the surviving provider identity and does not guess a provider for zero-attempt history', async () => {
    const list = await get<{ requests: RequestLogSummary[] }>('/api/admin/requests');
    expect(list.requests.find((r) => r.id === 'model-only-deleted')).toMatchObject({
      finalModelDeleted: true, providerId: activeProvider, providerName: 'Current provider', providerType: 'anthropic', providerDeleted: false,
    });
    expect(list.requests.find((r) => r.id === 'cache-only-deleted')).toMatchObject({
      finalModelDeleted: true, providerId: null, providerName: null, providerType: null, providerDeleted: false,
    });
    expect(list.requests.find((r) => r.id === 'active-raw')).toMatchObject({
      finalModelPublicId: 'current/model', finalModelDeleted: false, providerId: activeProvider, providerDeleted: false,
    });
  });

  it('reports raw historical provider attempts separately and leaves unknown cache semantics unavailable', async () => {
    const snapshot = await stats(rawDay);
    expect(snapshot.summary).toMatchObject({ totalRequests: 2, cacheReadTokens: 80, cacheHitRate: null });
    expect(snapshot.providers).toMatchObject([{ id: activeProvider, requests: 2, errorRate: 0.5, avgLatencyMs: 200 }]);
    expect(snapshot.historicalProviders).toEqual([{ id: missingProvider, name: `Deleted provider (${missingProvider})`, requests: 1, errorRate: 0, avgLatencyMs: 100 }]);
    expect(snapshot.topModels).toContainEqual(expect.objectContaining({ publicId: `Deleted model (${missingModel})`, requests: 1 }));
  });

  it('merges compacted and raw historical attempt counts once without counting the retained tail again', async () => {
    const snapshot = await stats(rawDay, compactedDay);
    expect(snapshot.percentilesAvailable).toBe(false);
    expect(snapshot.summary).toMatchObject({ totalRequests: 5, cacheHitRate: null });
    expect(snapshot.historicalProviders).toEqual([{ id: missingProvider, name: `Deleted provider (${missingProvider})`, requests: 5, errorRate: 0.2, avgLatencyMs: 175 }]);
    expect(snapshot.providers.some((p) => p.id === missingProvider)).toBe(false);
  });

  it('uses the known Anthropic denominator when a missing model still has a known provider via its attempt', async () => {
    const snapshot = await stats(knownDay);
    expect(snapshot.summary.cacheHitRate).toBeCloseTo(0.4);
  });

  it('keeps unknown cache semantics unavailable across later live events', () => {
    const event: LiveRequestShape = {
      id: 'event', createdAt: new Date().toISOString(), requestedModel: 'combo/example', finalModelPublicId: 'current/model',
      providerId: activeProvider, providerName: 'Current provider', providerType: 'anthropic', success: true, httpStatus: 200,
      inputTokens: 60, outputTokens: 10, cacheReadTokens: 40, totalLatencyMs: 100, attemptsCount: 1, gatewayCacheHit: false,
    };
    const known = advanceLiveTally(EMPTY_TALLY, event);
    expect(cacheHitRateOf(known)).toBeCloseTo(0.4);
    const unknown = advanceLiveTally(known, { ...event, providerId: missingProvider, providerType: null, providerDeleted: true });
    expect(cacheHitRateOf(unknown)).toBeNull();
    expect(cacheHitRateOf(advanceLiveTally(unknown, event))).toBeNull();
    expect(cacheHitRateOf(advanceLiveTally({ ...EMPTY_TALLY, cacheSemanticsUnknown: true }, event))).toBeNull();
  });
});
