// Admin API: statistics (Today/7d/30d) + routing dashboard data.

import type { FastifyInstance } from 'fastify';
import { and, eq, gte, lte, sql, desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { toSummary, loadSummaryMaps } from './requests';
import type { StatsSummary, StatsRange, RoutingProvider } from '../../../shared/types';

const PRESETS: Record<string, () => { from: Date; to: Date; bucket: 'hour' | 'day' }> = {
  today: () => {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { from, to: now, bucket: 'hour' };
  },
  '7d': () => {
    const now = new Date();
    return { from: new Date(now.getTime() - 7 * 24 * 3600 * 1000), to: now, bucket: 'day' };
  },
  '30d': () => {
    const now = new Date();
    return { from: new Date(now.getTime() - 30 * 24 * 3600 * 1000), to: now, bucket: 'day' };
  },
};

function rangeFromQuery(q: Record<string, string | undefined>): { from: Date; to: Date; bucket: 'hour' | 'day' } {
  if (q.preset && PRESETS[q.preset]) return PRESETS[q.preset]!();
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const to = q.to ? new Date(q.to) : new Date();
  return { from, to, bucket: q.bucket === 'hour' ? 'hour' : 'day' };
}

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/stats', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { from, to, bucket } = rangeFromQuery(q);
    const db = getDb();
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const conds = [gte(schema.requests.createdAt, fromIso), lte(schema.requests.createdAt, toIso)];

    const summary = db
      .select({
        total: sql<number>`COUNT(*)`,
        success: sql<number>`SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)`,
        inputTokens: sql<number>`COALESCE(SUM(input_tokens),0)`,
        outputTokens: sql<number>`COALESCE(SUM(output_tokens),0)`,
        cacheRead: sql<number>`COALESCE(SUM(cache_read_tokens),0)`,
        cacheWrite: sql<number>`COALESCE(SUM(cache_write_tokens),0)`,
        reasoning: sql<number>`COALESCE(SUM(reasoning_tokens),0)`,
        gatewayCacheHits: sql<number>`SUM(CASE WHEN gateway_cache_hit=1 THEN 1 ELSE 0 END)`,
        fallbacks: sql<number>`SUM(CASE WHEN attempts_count > 1 THEN 1 ELSE 0 END)`,
      })
      .from(schema.requests)
      .where(and(...conds))
      .get();

    const latRows = db
      .select({ v: schema.requests.totalLatencyMs })
      .from(schema.requests)
      .where(and(...conds, eq(schema.requests.success, true)))
      .all();
    const latencies = latRows.map((r) => r.v).filter((v) => v > 0).sort((a, b) => a - b);
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p95 = percentile(latencies, 95);

    const ttftRows = db
      .select({ v: schema.requests.ttftMs })
      .from(schema.requests)
      .where(and(...conds, sql`ttft_ms IS NOT NULL`))
      .all();
    const ttfts = ttftRows.map((r) => r.v).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const avgTtft = ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null;
    const p95Ttft = ttfts.length ? percentile(ttfts, 95) : null;

    const total = Number(summary?.total ?? 0);
    const success = Number(summary?.success ?? 0);
    const failed = Number(summary?.failed ?? 0);

    const statsSummary: StatsSummary = {
      totalRequests: total,
      successfulRequests: success,
      failedRequests: failed,
      successRate: total ? success / total : 0,
      inputTokens: Number(summary?.inputTokens ?? 0),
      outputTokens: Number(summary?.outputTokens ?? 0),
      totalTokens: Number(summary?.inputTokens ?? 0) + Number(summary?.outputTokens ?? 0),
      cacheReadTokens: Number(summary?.cacheRead ?? 0),
      cacheWriteTokens: Number(summary?.cacheWrite ?? 0),
      reasoningTokens: Number(summary?.reasoning ?? 0),
      averageLatencyMs: avg,
      p95LatencyMs: p95,
      averageTtftMs: avgTtft,
      p95TtftMs: p95Ttft,
      cacheHitRate: success ? Number(summary?.cacheRead ?? 0) > 0 ? Number(summary?.cacheRead ?? 0) / Math.max(1, Number(summary?.inputTokens ?? 0) + Number(summary?.cacheRead ?? 0)) : 0 : 0,
      gatewayCacheHitRate: total ? Number(summary?.gatewayCacheHits ?? 0) / total : 0,
      fallbackRate: total ? Number(summary?.fallbacks ?? 0) / total : 0,
    };

    // Time-bucketed series
    const bucketExpr = bucket === 'hour' ? sql<string>`strftime('%Y-%m-%dT%H:00:00Z', created_at)` : sql<string>`strftime('%Y-%m-%dT00:00:00Z', created_at)`;
    const seriesRows = db
      .select({
        t: bucketExpr,
        requests: sql<number>`COUNT(*)`,
        errors: sql<number>`SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)`,
        inputTokens: sql<number>`COALESCE(SUM(input_tokens),0)`,
        outputTokens: sql<number>`COALESCE(SUM(output_tokens),0)`,
        avgLatency: sql<number>`COALESCE(AVG(CASE WHEN success=1 THEN total_latency_ms END),0)`,
        cacheRead: sql<number>`COALESCE(SUM(cache_read_tokens),0)`,
      })
      .from(schema.requests)
      .where(and(...conds))
      .groupBy(bucketExpr)
      .orderBy(bucketExpr)
      .all();

    // Top models
    const topModels = db
      .select({
        modelId: schema.requests.finalModelId,
        c: sql<number>`COUNT(*)`,
        err: sql<number>`SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)`,
        tokens: sql<number>`COALESCE(SUM(total_tokens),0)`,
      })
      .from(schema.requests)
      .where(and(...conds))
      .groupBy(schema.requests.finalModelId)
      // Order by the aggregate expression itself: SQLite rejects ORDER BY on a
      // quoted select alias ("no such column: c").
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10)
      .all();
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const topKeys = db
      .select({
        apiKeyId: schema.requests.apiKeyId,
        c: sql<number>`COUNT(*)`,
        tokens: sql<number>`COALESCE(SUM(total_tokens),0)`,
      })
      .from(schema.requests)
      .where(and(...conds))
      .groupBy(schema.requests.apiKeyId)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10)
      .all();
    const keys = db.select().from(schema.apiKeys).all();
    const keyMap = new Map(keys.map((k) => [k.id, k]));

    // ─── Previous period (for delta badges in summary cards) ───────────────
    const durationMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - durationMs).toISOString();
    const prevTo   = from.toISOString();
    const previousSummary = buildSummary(db, prevFrom, prevTo);

    // ─── Recent requests (last 10, full RequestLogSummary) ─────────────────
    const maps = loadSummaryMaps();
    const recentRows = db
      .select()
      .from(schema.requests)
      .orderBy(desc(schema.requests.createdAt))
      .limit(10)
      .all();
    const recent = recentRows.map((r) => toSummary(r, maps));

    // ─── Providers: traffic + latency + health for routing-flow diagram ────
    const providerAggs = db
      .select({
        providerId: schema.requestAttempts.providerId,
        total:     sql<number>`COUNT(*)`,
        err:       sql<number>`SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)`,
        avgLat:    sql<number>`COALESCE(AVG(CASE WHEN success=1 THEN latency_ms END),0)`,
      })
      .from(schema.requestAttempts)
      .where(and(gte(schema.requestAttempts.startedAt, fromIso), lte(schema.requestAttempts.startedAt, toIso)))
      .groupBy(schema.requestAttempts.providerId)
      .all();
    const allProviders = db.select().from(schema.providers).all();
    const providerLookup = new Map(allProviders.map((p) => [p.id, p]));
    const modelCounts = db
      .select({ providerId: schema.models.providerId, c: sql<number>`COUNT(*)` })
      .from(schema.models)
      .groupBy(schema.models.providerId)
      .all();
    const countMap = new Map(modelCounts.map((r) => [r.providerId, Number(r.c)]));
    const providers: RoutingProvider[] = providerAggs
      .map((r) => {
        const p = providerLookup.get(r.providerId);
        if (!p) return null;
        const total = Number(r.total);
        return {
          id: r.providerId,
          name: p.name,
          slug: p.slug,
          health: p.healthState as RoutingProvider['health'],
          enabled: p.enabled,
          modelCount: countMap.get(r.providerId) ?? 0,
          requests: total,
          errorRate: total > 0 ? Number(r.err) / total : 0,
          avgLatencyMs: Number(r.avgLat),
        };
      })
      .filter((x): x is RoutingProvider => x !== null)
      .sort((a, b) => b.requests - a.requests);

    const range: StatsRange = { from: fromIso, to: toIso, bucket };
    return {
      range,
      summary: statsSummary,
      previous: previousSummary,
      series: seriesRows.map((r) => ({ t: r.t, requests: Number(r.requests), errors: Number(r.errors), inputTokens: Number(r.inputTokens), outputTokens: Number(r.outputTokens), avgLatency: Number(r.avgLatency ?? 0), cacheRead: Number(r.cacheRead ?? 0) })),
      topModels: topModels.map((r) => ({
        publicId: r.modelId ? modelMap.get(r.modelId)?.publicModelId ?? r.modelId : 'unknown',
        requests: Number(r.c),
        errorRate: Number(r.c) > 0 ? Number(r.err) / Number(r.c) : 0,
        totalTokens: Number(r.tokens),
      })),
      topApiKeys: topKeys.map((r) => ({
        name: r.apiKeyId ? keyMap.get(r.apiKeyId)?.name ?? 'deleted' : 'unknown',
        requests: Number(r.c),
        totalTokens: Number(r.tokens),
      })),
      recent,
      providers,
    };
  });
}

/**
 * Fast summary (no percentiles / TTFT — used for previous window and live
 * incremental aggregation). Returns counts sufficient to derive ratios.
 */
function buildSummary(db: BetterSQLite3Database<typeof schema>, fromIso: string, toIso: string): StatsSummary {
  const conds = [gte(schema.requests.createdAt, fromIso), lte(schema.requests.createdAt, toIso)];
  const r = db
    .select({
      total: sql<number>`COUNT(*)`,
      success: sql<number>`SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)`,
      inputTokens: sql<number>`COALESCE(SUM(input_tokens),0)`,
      outputTokens: sql<number>`COALESCE(SUM(output_tokens),0)`,
      cacheRead: sql<number>`COALESCE(SUM(cache_read_tokens),0)`,
      cacheWrite: sql<number>`COALESCE(SUM(cache_write_tokens),0)`,
      reasoning: sql<number>`COALESCE(SUM(reasoning_tokens),0)`,
      avgLatency: sql<number>`COALESCE(AVG(CASE WHEN success=1 THEN total_latency_ms END),0)`,
      avgTtft: sql<number | null>`AVG(CASE WHEN success=1 AND ttft_ms IS NOT NULL THEN ttft_ms END)`,
      gatewayCacheHits: sql<number>`SUM(CASE WHEN gateway_cache_hit=1 THEN 1 ELSE 0 END)`,
      fallbacks: sql<number>`SUM(CASE WHEN attempts_count > 1 THEN 1 ELSE 0 END)`,
    })
    .from(schema.requests)
    .where(and(...conds))
    .get();

  const total = Number(r?.total ?? 0);
  const success = Number(r?.success ?? 0);
  const cacheRead = Number(r?.cacheRead ?? 0);
  const inputTokens = Number(r?.inputTokens ?? 0);

  return {
    totalRequests: total,
    successfulRequests: success,
    failedRequests: Number(r?.failed ?? 0),
    successRate: total ? success / total : 0,
    inputTokens,
    outputTokens: Number(r?.outputTokens ?? 0),
    totalTokens: inputTokens + Number(r?.outputTokens ?? 0),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: Number(r?.cacheWrite ?? 0),
    reasoningTokens: Number(r?.reasoning ?? 0),
    averageLatencyMs: Number(r?.avgLatency ?? 0),
    p95LatencyMs: 0,   // caller fills via percentile query
    averageTtftMs: (r?.avgTtft ?? null) as number | null,
    p95TtftMs: null,
    cacheHitRate: success ? cacheRead > 0 ? cacheRead / Math.max(1, inputTokens + cacheRead) : 0 : 0,
    gatewayCacheHitRate: total ? Number(r?.gatewayCacheHits ?? 0) / total : 0,
    fallbackRate: total ? Number(r?.fallbacks ?? 0) / total : 0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
