// Admin API: statistics (Today/7d/30d) + routing dashboard data.

import type { FastifyInstance } from 'fastify';
import { and, eq, gte, lte, sql, desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { GatewayError } from '../../errors';
import { toSummary, loadSummaryMaps } from './requests';
import type { StatsSummary, StatsRange, RoutingProvider } from '../../../shared/types';

/**
 * Midnight UTC, `offsetDays` from the day containing `now`.
 *
 * Preset windows are day-aligned on purpose. A rolling window always clips its first day, and a
 * clipped day whose raw rows were pruned cannot be reconstructed from the day-granular aggregate —
 * so a compacted install answered 400 for every preset the UI can send. Aligning the window makes
 * the first day whole and leaves only today partial, which is never served from an aggregate.
 */
function utcDayStart(now: Date, offsetDays: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
}

const PRESETS: Record<string, () => { from: Date; to: Date; bucket: 'hour' | 'day' }> = {
  today: () => {
    const now = new Date();
    return { from: utcDayStart(now, 0), to: now, bucket: 'hour' };
  },
  '7d': () => {
    const now = new Date();
    return { from: utcDayStart(now, -6), to: now, bucket: 'day' };
  },
  '30d': () => {
    const now = new Date();
    return { from: utcDayStart(now, -29), to: now, bucket: 'day' };
  },
};

/**
 * Provider-cache hit rate for a window.
 *
 * The blanket `cacheRead / (input + cacheRead)` double-counts the cache: OpenAI-compatible
 * providers report `cached_tokens` as a SUBSET of `prompt_tokens`, so the cached prefix is
 * already inside `input` and adding it again inflates the denominator — understating the
 * rate (measured on real traffic: 21.75% instead of 27.80%).
 *
 * Anthropic is the exception: its `input_tokens` EXCLUDES the cached prefix, so there the
 * prompt really is `input + cache`. Each row is weighed by its provider's own `type` in a
 * single pass.
 */
function cacheHitRateFor(
  db: BetterSQLite3Database<typeof schema>,
  conds: Parameters<typeof and>
): number {
  const anthropic = sql`${schema.providers.type} = 'anthropic'`;
  const r = db
    .select({
      cacheRead: sql<number>`COALESCE(SUM(${schema.requests.cacheReadTokens}),0)`,
      anthropicPrompt: sql<number>`COALESCE(SUM(CASE WHEN ${anthropic} THEN ${schema.requests.inputTokens} + ${schema.requests.cacheReadTokens} ELSE 0 END),0)`,
      otherPrompt: sql<number>`COALESCE(SUM(CASE WHEN ${anthropic} THEN 0 ELSE ${schema.requests.inputTokens} END),0)`,
    })
    .from(schema.requests)
    .leftJoin(schema.models, eq(schema.models.id, schema.requests.finalModelId))
    .leftJoin(schema.providers, eq(schema.providers.id, schema.models.providerId))
    .where(and(...conds))
    .get();
  const prompt = Number(r?.anthropicPrompt ?? 0) + Number(r?.otherPrompt ?? 0);
  return prompt > 0 ? Number(r?.cacheRead ?? 0) / prompt : 0;
}

function rangeFromQuery(q: Record<string, string | undefined>): { from: Date; to: Date; bucket: 'hour' | 'day' } {
  if (q.preset && PRESETS[q.preset]) return PRESETS[q.preset]!();
  const now = new Date();
  const from = q.from ? new Date(q.from) : utcDayStart(now, -6);
  const to = q.to ? new Date(q.to) : now;
  return { from, to, bucket: q.bucket === 'hour' ? 'hour' : 'day' };
}

/**
 * UTC days whose raw request detail is gone and that therefore must be answered from the
 * day-granular aggregate.
 *
 * Having a `daily_model_stats` row proves nothing: the aggregate is written for EVERY logged
 * request, so every day with traffic has one, and treating that as "compacted" made every
 * rolling preset (whose window always clips its first day) answer 400. Only the raw log
 * separates the states, and only a day holding FEWER raw rows than it logged needs its
 * aggregate — which is exactly what retention (cutoff mid-day) and a compact export/restore
 * leave behind.
 *
 * Counted over whole UTC days, never the requested window: a clipped first day still has all
 * of its raw rows, and comparing a window-scoped count against a whole-day aggregate would
 * report every such day as pruned. `created_at` is indexed, so this is one grouped range scan.
 */
function aggregateRequiredDays(
  db: BetterSQLite3Database<typeof schema>,
  aggregateRows: { day: string; requests: number }[]
): string[] {
  const loggedByDay = new Map<string, number>();
  for (const r of aggregateRows) loggedByDay.set(r.day, (loggedByDay.get(r.day) ?? 0) + r.requests);
  if (loggedByDay.size === 0) return [];
  // ISO-8601 UTC dates sort lexicographically, so min/max bound the whole-day scan.
  const days = [...loggedByDay.keys()].sort();
  const rawCounts = db
    .select({ day: sql<string>`substr(created_at,1,10)`, c: sql<number>`COUNT(*)` })
    .from(schema.requests)
    .where(and(gte(schema.requests.createdAt, `${days[0]}T00:00:00.000Z`), lte(schema.requests.createdAt, `${days[days.length - 1]}T23:59:59.999Z`)))
    .groupBy(sql`substr(created_at,1,10)`)
    .all();
  const rawByDay = new Map(rawCounts.map((r) => [r.day, Number(r.c)]));
  return [...loggedByDay].filter(([day, logged]) => (rawByDay.get(day) ?? 0) < logged).map(([day]) => day);
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
    const utcToday = new Date().toISOString().slice(0, 10);
    const aggregateRows = db.select().from(schema.dailyModelStats).where(and(gte(schema.dailyModelStats.day, fromIso.slice(0, 10)), lte(schema.dailyModelStats.day, toIso.slice(0, 10)))).all();
    // Only days whose raw detail is actually gone are answered from the day-granular aggregate.
    // A day that still has its raw rows is served from raw, exactly like a fresh install.
    const aggregateDays = aggregateRequiredDays(db, aggregateRows)
      .filter((day) => day < utcToday && `${day}T00:00:00.000Z` <= toIso && `${day}T23:59:59.999Z` >= fromIso);
    const clippedDays = aggregateDays.filter((day) => `${day}T00:00:00.000Z` < fromIso || `${day}T23:59:59.999Z` > toIso);
    if (clippedDays.length > 0) {
      throw new GatewayError('invalid_request_error', 'Statistics ranges overlapping compacted history must include complete UTC days.', { status: 400 });
    }
    const percentilesAvailable = aggregateDays.length === 0;
    const aggregateOnly = aggregateDays.length > 0;
    const rawConds = aggregateDays.length
      ? and(...conds, sql`substr(created_at,1,10) NOT IN (${sql.join(aggregateDays.map((day) => sql`${day}`), sql`, `)})`)
      : and(...conds);
    const aggregateTotals = aggregateRows.filter((r) => aggregateDays.includes(r.day)).reduce((a, r) => ({ total: a.total + r.requests, success: a.success + r.successfulRequests, failed: a.failed + r.failedRequests, input: a.input + r.inputTokens, output: a.output + r.outputTokens, cacheRead: a.cacheRead + r.cacheReadTokens, cacheWrite: a.cacheWrite + r.cacheWriteTokens, reasoning: a.reasoning + r.reasoningTokens, gateway: a.gateway + r.gatewayCacheHits, fallback: a.fallback + r.fallbackRequests, latencySum: a.latencySum + r.latencySuccessSumMs, latencyCount: a.latencyCount + r.latencySuccessCount, ttftSum: a.ttftSum + r.ttftSumMs, ttftCount: a.ttftCount + r.ttftCount }), { total: 0, success: 0, failed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, gateway: 0, fallback: 0, latencySum: 0, latencyCount: 0, ttftSum: 0, ttftCount: 0 });

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
      .where(rawConds)
      .get();
    // Aggregate rows retain cache counts but not provider-specific prompt denominator semantics.
    const cacheHitRate = aggregateDays.length ? null : cacheHitRateFor(db, conds);

    const latRows = db
      .select({ v: schema.requests.totalLatencyMs })
      .from(schema.requests)
      .where(and(rawConds, eq(schema.requests.success, true)))
      .all();
    const latencies = latRows.map((r) => r.v).filter((v) => v > 0).sort((a, b) => a - b);
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p95 = percentile(latencies, 95);

    const ttftRows = db
      .select({ v: schema.requests.ttftMs })
      .from(schema.requests)
      .where(and(rawConds, sql`ttft_ms IS NOT NULL`))
      .all();
    const ttfts = ttftRows.map((r) => r.v).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const avgTtft = ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null;
    const p95Ttft = ttfts.length ? percentile(ttfts, 95) : null;

    const total = Number(summary?.total ?? 0) + aggregateTotals.total;
    const success = Number(summary?.success ?? 0) + aggregateTotals.success;
    const failed = Number(summary?.failed ?? 0) + aggregateTotals.failed;

    const statsSummary: StatsSummary = {
      totalRequests: total,
      successfulRequests: success,
      failedRequests: failed,
      successRate: total ? success / total : 0,
      inputTokens: Number(summary?.inputTokens ?? 0) + aggregateTotals.input,
      outputTokens: Number(summary?.outputTokens ?? 0) + aggregateTotals.output,
      totalTokens: Number(summary?.inputTokens ?? 0) + aggregateTotals.input + Number(summary?.outputTokens ?? 0) + aggregateTotals.output,
      cacheReadTokens: Number(summary?.cacheRead ?? 0) + aggregateTotals.cacheRead,
      cacheWriteTokens: Number(summary?.cacheWrite ?? 0) + aggregateTotals.cacheWrite,
      reasoningTokens: Number(summary?.reasoning ?? 0) + aggregateTotals.reasoning,
      averageLatencyMs: aggregateOnly ? (aggregateTotals.latencySum + latencies.reduce((a, b) => a + b, 0)) / (aggregateTotals.latencyCount + latencies.length || 1) : avg,
      p95LatencyMs: percentilesAvailable ? p95 : null,
      averageTtftMs: aggregateOnly ? (aggregateTotals.ttftSum + ttfts.reduce((a, b) => a + b, 0)) / (aggregateTotals.ttftCount + ttfts.length || 1) : avgTtft,
      p95TtftMs: percentilesAvailable ? p95Ttft : null,
      cacheHitRate,
      gatewayCacheHitRate: total ? (Number(summary?.gatewayCacheHits ?? 0) + aggregateTotals.gateway) / total : 0,
      fallbackRate: total ? (Number(summary?.fallbacks ?? 0) + aggregateTotals.fallback) / total : 0,
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
      .where(rawConds)
            .groupBy(bucketExpr)
            .orderBy(bucketExpr)
            .all();
            const seriesMap = new Map(seriesRows.map((r) => [r.t, { t: r.t, requests: Number(r.requests), errors: Number(r.errors), inputTokens: Number(r.inputTokens), outputTokens: Number(r.outputTokens), avgLatency: Number(r.avgLatency ?? 0), cacheRead: Number(r.cacheRead ?? 0) }]));
            for (const r of aggregateRows.filter((x) => aggregateDays.includes(x.day))) {
              const t = `${r.day}T00:00:00Z`;
              const old = seriesMap.get(t) ?? { t, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, avgLatency: 0, cacheRead: 0 };
              const oldSuccesses = old.requests - old.errors;
              const count = oldSuccesses + r.latencySuccessCount;
              seriesMap.set(t, { t, requests: old.requests + r.requests, errors: old.errors + r.failedRequests, inputTokens: old.inputTokens + r.inputTokens, outputTokens: old.outputTokens + r.outputTokens, avgLatency: count ? (old.avgLatency * oldSuccesses + r.latencySuccessSumMs) / count : 0, cacheRead: old.cacheRead + r.cacheReadTokens });
            }

    // Top models
    const topModels = db
      .select({
        modelId: schema.requests.finalModelId,
        c: sql<number>`COUNT(*)`,
        err: sql<number>`SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)`,
        tokens: sql<number>`COALESCE(SUM(total_tokens),0)`,
      })
      .from(schema.requests)
      .where(rawConds)
      .groupBy(schema.requests.finalModelId)
      // Order by the aggregate expression itself: SQLite rejects ORDER BY on a
      // quoted select alias ("no such column: c").
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10)
      .all();
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const mergedModels = new Map<string, { requests: number; errors: number; tokens: number }>();
    for (const r of topModels) { const id = r.modelId ? modelMap.get(r.modelId)?.publicModelId ?? r.modelId : 'unknown'; const v = mergedModels.get(id) ?? { requests: 0, errors: 0, tokens: 0 }; v.requests += Number(r.c); v.errors += Number(r.err); v.tokens += Number(r.tokens); mergedModels.set(id, v); }
    for (const r of aggregateRows.filter((x) => aggregateDays.includes(x.day))) { const id = r.modelId ? modelMap.get(r.modelId)?.publicModelId ?? r.modelId : 'unknown'; const v = mergedModels.get(id) ?? { requests: 0, errors: 0, tokens: 0 }; v.requests += r.requests; v.errors += r.failedRequests; v.tokens += r.inputTokens + r.outputTokens; mergedModels.set(id, v); }
    const topKeys = db
      .select({
        apiKeyId: schema.requests.apiKeyId,
        c: sql<number>`COUNT(*)`,
        tokens: sql<number>`COALESCE(SUM(total_tokens),0)`,
      })
      .from(schema.requests)
      .where(rawConds)
      .groupBy(schema.requests.apiKeyId)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10)
      .all();
    const keys = db.select().from(schema.apiKeys).all();
    const keyMap = new Map(keys.map((k) => [k.id, k]));
    const mergedKeys = new Map<string, { requests: number; tokens: number }>();
    for (const r of topKeys) { const id = r.apiKeyId ? keyMap.get(r.apiKeyId)?.name ?? 'deleted' : 'unknown'; const v = mergedKeys.get(id) ?? { requests: 0, tokens: 0 }; v.requests += Number(r.c); v.tokens += Number(r.tokens); mergedKeys.set(id, v); }
    const keyAggregateRows = db.select().from(schema.dailyApiKeyStats).where(and(gte(schema.dailyApiKeyStats.day, fromIso.slice(0, 10)), lte(schema.dailyApiKeyStats.day, toIso.slice(0, 10)))).all().filter((r) => aggregateDays.includes(r.day));
    for (const r of keyAggregateRows) { const id = r.apiKeyId ? keyMap.get(r.apiKeyId)?.name ?? 'deleted' : 'unknown'; const v = mergedKeys.get(id) ?? { requests: 0, tokens: 0 }; v.requests += r.requests; v.tokens += r.totalTokens; mergedKeys.set(id, v); }

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
    const providerTotals = new Map(providerAggs.map((r) => [r.providerId, { total: Number(r.total), errors: Number(r.err), latencySum: Number(r.avgLat) * (Number(r.total) - Number(r.err)), latencyCount: Number(r.total) - Number(r.err) }]));
    const providerAggregateRows = db.select().from(schema.dailyProviderStats).where(and(gte(schema.dailyProviderStats.day, fromIso.slice(0, 10)), lte(schema.dailyProviderStats.day, toIso.slice(0, 10)))).all().filter((r) => aggregateDays.includes(r.day));
    for (const r of providerAggregateRows) { const a = providerTotals.get(r.providerId) ?? { total: 0, errors: 0, latencySum: 0, latencyCount: 0 }; a.total += r.attempts; a.errors += r.failedAttempts; a.latencySum += r.latencySuccessSumMs; a.latencyCount += r.latencySuccessCount; providerTotals.set(r.providerId, a); }
    const providers: RoutingProvider[] = [...providerTotals].map(([providerId, r]) => {
        const p = providerLookup.get(providerId);
        if (!p) return null;
        const total = r.total;
        return {
          id: providerId,
          name: p.name,
          slug: p.slug,
          health: p.healthState as RoutingProvider['health'],
          enabled: p.enabled,
          modelCount: countMap.get(providerId) ?? 0,
          requests: total,
          errorRate: total > 0 ? r.errors / total : 0,
          avgLatencyMs: r.latencyCount ? r.latencySum / r.latencyCount : 0,
        };
      })
      .filter((x): x is RoutingProvider => x !== null)
      .sort((a, b) => b.requests - a.requests);

    const range: StatsRange = { from: fromIso, to: toIso, bucket };
    return {
      percentilesAvailable,
      range,
      summary: statsSummary,
      previous: previousSummary,
      series: [...seriesMap.values()].sort((a, b) => a.t.localeCompare(b.t)),
      topModels: [...mergedModels].map(([publicId, v]) => ({ publicId, requests: v.requests, errorRate: v.requests ? v.errors / v.requests : 0, totalTokens: v.tokens })).sort((a, b) => b.requests - a.requests).slice(0, 10),
      topApiKeys: [...mergedKeys].map(([name, v]) => ({ name, requests: v.requests, totalTokens: v.tokens })).sort((a, b) => b.requests - a.requests).slice(0, 10),
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
  // For previous period, use the same aggregate/raw partition as the primary range.
  const days = db.select().from(schema.dailyModelStats).where(and(gte(schema.dailyModelStats.day, fromIso.slice(0, 10)), lte(schema.dailyModelStats.day, toIso.slice(0, 10)))).all();
  // Same rule as the primary range: a day only needs its aggregate when its raw detail is gone.
  const daySet = aggregateRequiredDays(db, days).filter((day) => day < new Date().toISOString().slice(0, 10) && `${day}T00:00:00.000Z` >= fromIso && `${day}T23:59:59.999Z` <= toIso);
  const aggregates = days.filter((x) => daySet.includes(x.day));
  const rawOnly = daySet.length ? and(gte(schema.requests.createdAt, fromIso), lte(schema.requests.createdAt, toIso), sql`substr(created_at,1,10) NOT IN (${sql.join(daySet.map((day) => sql`${day}`), sql`, `)})`) : and(gte(schema.requests.createdAt, fromIso), lte(schema.requests.createdAt, toIso));
  const agg = aggregates.reduce((a, x) => ({ total: a.total + x.requests, success: a.success + x.successfulRequests, failed: a.failed + x.failedRequests, input: a.input + x.inputTokens, output: a.output + x.outputTokens, cacheRead: a.cacheRead + x.cacheReadTokens, cacheWrite: a.cacheWrite + x.cacheWriteTokens, reasoning: a.reasoning + x.reasoningTokens, gateway: a.gateway + x.gatewayCacheHits, fallback: a.fallback + x.fallbackRequests, latency: a.latency + x.latencySuccessSumMs, latencyCount: a.latencyCount + x.latencySuccessCount, ttft: a.ttft + x.ttftSumMs, ttftCount: a.ttftCount + x.ttftCount }), { total: 0, success: 0, failed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, gateway: 0, fallback: 0, latency: 0, latencyCount: 0, ttft: 0, ttftCount: 0 });

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
      latencySum: sql<number>`COALESCE(SUM(CASE WHEN success=1 THEN total_latency_ms ELSE 0 END),0)`,
      latencyCount: sql<number>`SUM(CASE WHEN success=1 AND total_latency_ms > 0 THEN 1 ELSE 0 END)`,
      ttftSum: sql<number>`COALESCE(SUM(CASE WHEN success=1 THEN COALESCE(ttft_ms,0) ELSE 0 END),0)`,
      ttftCount: sql<number>`SUM(CASE WHEN success=1 AND ttft_ms IS NOT NULL THEN 1 ELSE 0 END)`,
      gatewayCacheHits: sql<number>`SUM(CASE WHEN gateway_cache_hit=1 THEN 1 ELSE 0 END)`,
      fallbacks: sql<number>`SUM(CASE WHEN attempts_count > 1 THEN 1 ELSE 0 END)`,
    })
    .from(schema.requests)
    .where(rawOnly)
    .get();

  const total = Number(r?.total ?? 0) + agg.total;
  const success = Number(r?.success ?? 0) + agg.success;
  const failed = Number(r?.failed ?? 0) + agg.failed;
  const inputTokens = Number(r?.inputTokens ?? 0) + agg.input;
  const outputTokens = Number(r?.outputTokens ?? 0) + agg.output;
  const latencyCount = Number(r?.latencyCount ?? 0) + agg.latencyCount;
  const ttftCount = Number(r?.ttftCount ?? 0) + agg.ttftCount;
  const cacheHitRate = daySet.length ? null : cacheHitRateFor(db, conds);

  return {
    totalRequests: total,
    successfulRequests: success,
    failedRequests: failed,
    successRate: total ? success / total : 0,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: Number(r?.cacheRead ?? 0) + agg.cacheRead,
    cacheWriteTokens: Number(r?.cacheWrite ?? 0) + agg.cacheWrite,
    reasoningTokens: Number(r?.reasoning ?? 0) + agg.reasoning,
    averageLatencyMs: latencyCount ? (Number(r?.latencySum ?? 0) + agg.latency) / latencyCount : 0,
    p95LatencyMs: null,
    averageTtftMs: ttftCount ? (Number(r?.ttftSum ?? 0) + agg.ttft) / ttftCount : null,
    p95TtftMs: null,
    cacheHitRate,
    gatewayCacheHitRate: total ? (Number(r?.gatewayCacheHits ?? 0) + agg.gateway) / total : 0,
    fallbackRate: total ? (Number(r?.fallbacks ?? 0) + agg.fallback) / total : 0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
