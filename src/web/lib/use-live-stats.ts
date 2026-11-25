// Realtime statistics data layer: SSE subscription + incremental aggregation.
// All data logic lives here — UI components only render what this hook returns.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { subscribeToRequestStream } from './request-stream';
import type { HistoricalProviderStats } from '../../shared/types';

export type Preset = 'today' | '7d' | '30d';

export interface StatsSummaryShape {
  totalRequests: number; successfulRequests: number; failedRequests: number; successRate: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  averageLatencyMs: number; p95LatencyMs: number | null;
  averageTtftMs: number | null; p95TtftMs: number | null;
  cacheHitRate: number | null; gatewayCacheHitRate: number; fallbackRate: number;
}

export interface RoutingProviderShape {
  id: string; name: string; slug: string;
  health: 'healthy' | 'degraded' | 'down' | 'circuit_open' | 'unknown';
  enabled: boolean; modelCount: number;
  requests: number; errorRate: number; avgLatencyMs: number;
}

export interface LiveRequestShape {
  id: string; createdAt: string; requestedModel: string; finalModelPublicId: string | null;
  providerId: string | null; providerName: string | null;
  success: boolean; httpStatus: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; totalLatencyMs: number; attemptsCount: number;
  gatewayCacheHit: boolean; providerType: string | null;
  providerDeleted?: boolean;
}

export interface Pulse { id: string; providerId: string; success: boolean }

export interface ActiveRoute { id: string; providerId: string; startedAt: number; ttftMs: number }

export interface StatsSnapshot {
  percentilesAvailable: boolean;
  range: { from: string; to: string; bucket: string };
  summary: StatsSummaryShape;
  previous: StatsSummaryShape;
  series: Array<{ t: string; requests: number; errors: number; inputTokens: number; outputTokens: number; avgLatency: number; cacheRead: number }>;
  topModels: Array<{ publicId: string; requests: number; errorRate: number; totalTokens: number }>;
  topApiKeys: Array<{ name: string; requests: number; totalTokens: number }>;
  recent: LiveRequestShape[];
  providers: RoutingProviderShape[];
  historicalProviders?: HistoricalProviderStats[];
}

const PULSE_MS = 1600; // animation duration
const MAX_RECENT = 10;
const MAX_PROVIDER_PULSES = 3;
const MAX_ACTIVE_ROUTES = 12;
const MAX_SEEN_IDS = 2000;
const ACTIVE_ROUTE_TIMEOUT_MS = 10 * 60_000; // safety: drop routes whose completion event never arrived

export interface UseLiveStatsResult {
  snapshot: StatsSnapshot | null;
  live: StatsSummaryShape; // snapshot summary + live increments
  recent: LiveRequestShape[];
  providers: RoutingProviderShape[];
  pulses: Pulse[];
  activeRoutes: ActiveRoute[]; // provider IDs currently being served (TTFT -> completion)
  loading: boolean;
  error: string | null;
}

/**
 * Counts the live SSE feed must carry so the derived rates can advance with it.
 * The averages' inputs (tokens, requests) are already in the summary; these four
 * are not summarizable, so they are tallied alongside it.
 */
export interface LiveTally {
  cacheReadTokens: number;
  /** The prompt of each provider, already expressed on ITS OWN denominator (see promptTokensFor). */
  promptTokens: number;
  /** A snapshot or event lacked the semantics needed to calculate the denominator. */
  cacheSemanticsUnknown?: boolean;
  gatewayCacheHits: number;
  fallbacks: number;
}

export const EMPTY_TALLY: LiveTally = { cacheReadTokens: 0, promptTokens: 0, gatewayCacheHits: 0, fallbacks: 0 };

/**
 * The size of the prompt a single request actually had to be fed.
 *
 * OpenAI-compatible providers report `cached_tokens` as a SUBSET of `prompt_tokens`, so the
 * cached prefix is already counted in `inputTokens`. Anthropic reports `input_tokens`
 * EXCLUDING the cached prefix — the prompt there is `input + cache`. Each request is
 * therefore normalised on its own provider's semantics, so the rates over a mixed window
 * stay correct instead of favouring whichever provider happens to dominate.
 */
export function promptTokensFor(inputTokens: number, cacheReadTokens: number, providerType: string | null): number {
  return providerType === 'anthropic' ? inputTokens + cacheReadTokens : inputTokens;
}

/** Cached share of the prompt that a provider actually served from its prompt cache. */
export function cacheHitRateOf(t: LiveTally): number | null {
  if (t.cacheSemanticsUnknown) return null;
  return t.promptTokens > 0 ? t.cacheReadTokens / t.promptTokens : 0;
}

export function advanceLiveTally(t: LiveTally, r: LiveRequestShape): LiveTally {
  return {
    cacheReadTokens: t.cacheReadTokens + r.cacheReadTokens,
    promptTokens: t.promptTokens + promptTokensFor(r.inputTokens, r.cacheReadTokens, r.providerType),
    cacheSemanticsUnknown: Boolean(t.cacheSemanticsUnknown || (r.cacheReadTokens > 0 && r.providerType !== 'openai' && r.providerType !== 'anthropic')),
    gatewayCacheHits: t.gatewayCacheHits + (r.gatewayCacheHit ? 1 : 0),
    fallbacks: t.fallbacks + (r.attemptsCount > 1 ? 1 : 0),
  };
}

/** Share of requests that needed more than the first attempt. */
export function fallbackRateOf(t: { fallbacks: number }, totalRequests: number): number {
  return totalRequests > 0 ? t.fallbacks / totalRequests : 0;
}

/** Requests the gateway answered from its own response cache. */
export function gatewayCacheHitRateOf(t: { gatewayCacheHits: number }, totalRequests: number): number {
  return totalRequests > 0 ? t.gatewayCacheHits / totalRequests : 0;
}

/** Merge a live SSE row into an incremental summary (mutates and returns it). */
function applyLiveSummary(s: StatsSummaryShape, t: LiveTally, r: LiveRequestShape): StatsSummaryShape {
  const totalRequests = s.totalRequests + 1;
  const successfulRequests = s.successfulRequests + (r.success ? 1 : 0);
  return {
    ...s,
    cacheReadTokens: t.cacheReadTokens,
    totalRequests,
    successfulRequests,
    failedRequests: s.failedRequests + (r.success ? 0 : 1),
    successRate: successfulRequests / totalRequests,
    inputTokens: s.inputTokens + r.inputTokens,
    outputTokens: s.outputTokens + r.outputTokens,
    totalTokens: s.totalTokens + r.inputTokens + r.outputTokens,
    // Unlike tokens/latency, a rate is a ratio — summing it (as this did) is
    // meaningless. Re-derive each from its running totals instead.
    cacheHitRate: cacheHitRateOf(t),
    gatewayCacheHitRate: gatewayCacheHitRateOf(t, totalRequests),
    fallbackRate: fallbackRateOf(t, totalRequests),
    averageLatencyMs: (s.averageLatencyMs * s.totalRequests + r.totalLatencyMs) / totalRequests,
  };
}

export function useLiveStats(preset: Preset): UseLiveStatsResult {
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [live, setLive] = useState<StatsSummaryShape | null>(null);
  const [recent, setRecent] = useState<LiveRequestShape[]>([]);
  const [providers, setProviders] = useState<RoutingProviderShape[]>([]);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [activeRoutes, setActiveRoutes] = useState<ActiveRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refs: read by the SSE effect without re-subscribing.
  const providersRef = useRef<RoutingProviderShape[]>([]);
  const liveRef = useRef<StatsSummaryShape | null>(null);
  // Running totals behind the derived rates, reseeded from each snapshot.
  const tallyRef = useRef<LiveTally>(EMPTY_TALLY);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const snapshotCursorRef = useRef<number>(0);
  const pulseIdRef = useRef(0);
  const pulsesRef = useRef<Pulse[]>([]);
  const activeRoutesRef = useRef<ActiveRoute[]>([]);

  // ── Snapshot fetch (on mount + preset change) ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get<StatsSnapshot>(`/api/admin/stats?preset=${preset}`)
      .then((r) => {
        if (cancelled) return;
        const snapshotCursor = new Date(r.range.to).getTime();
        snapshotCursorRef.current = Number.isFinite(snapshotCursor) ? snapshotCursor : Date.now();
        // Only IDs included in this snapshot are considered seen. The SSE
        // subscription is restarted from the snapshot's exact cutoff below.
        seenIdsRef.current = new Set(r.recent.map((row) => row.id));
        setSnapshot(r);
        setLive(r.summary);
        liveRef.current = r.summary;
        // The rates in `summary` were computed server-side; the live increments append
        // to the same tallies, so seed them with what that snapshot summed.
        tallyRef.current = {
          cacheReadTokens: r.summary.cacheReadTokens,
          cacheSemanticsUnknown: r.summary.cacheHitRate === null,
          // The server's rate already encodes each provider's own denominator, so invert it
          // to recover the mixed-provider prompt total (a raw inputTokens sum cannot express
          // it). Rounded: a token count is an integer, so this drops float noise only. With
          // no cache reads the rate is 0 and no inversion is possible — the plain sum is
          // then correct anyway, since nothing was cached.
          promptTokens: r.summary.cacheHitRate !== null && r.summary.cacheHitRate > 0
            ? Math.round(r.summary.cacheReadTokens / r.summary.cacheHitRate)
            : r.summary.inputTokens,
          gatewayCacheHits: Math.round(r.summary.gatewayCacheHitRate * r.summary.totalRequests),
          fallbacks: Math.round(r.summary.fallbackRate * r.summary.totalRequests),
        };
        setRecent(r.recent);
        setProviders(r.providers);
        providersRef.current = r.providers;
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [preset]);

  // ── SSE live stream ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // A preset change replaces the snapshot; discard transient animation state
    // from the previous window rather than leaving orphaned pulses on screen.
    pulsesRef.current = [];
    activeRoutesRef.current = [];
    setPulses([]);
    setActiveRoutes([]);
    const unsubscribe = subscribeToRequestStream<LiveRequestShape>(
      snapshotCursorRef.current,
      (row) => {
        if (cancelled) return;
        const seenMs = new Date(row.createdAt).getTime();
        // The stats snapshot already includes every completion through range.to.
        // Ignore its inclusive boundary row to avoid counting it twice.
        if (Number.isFinite(seenMs) && seenMs <= snapshotCursorRef.current) return;
        if (seenIdsRef.current.has(row.id)) return; // replay duplicate
        seenIdsRef.current.add(row.id);
        if (seenIdsRef.current.size > MAX_SEEN_IDS) {
          const oldestId = seenIdsRef.current.values().next().value;
          if (oldestId) seenIdsRef.current.delete(oldestId);
        }

        // Live summary increments. Each row is normalised on its own provider's token
        // semantics, so a mixed window stays correct without knowing the whole mix.
        const nextTally = advanceLiveTally(tallyRef.current, row);
        tallyRef.current = nextTally;
        if (liveRef.current) {
          liveRef.current = applyLiveSummary(liveRef.current, nextTally, row);
          setLive(liveRef.current);
        }
        setRecent((prev) => {
          if (prev.some((r) => r.id === row.id)) return prev;
          return [row, ...prev].slice(0, MAX_RECENT);
        });
        if (row.providerId && !row.providerDeleted && providersRef.current.some((p) => p.id === row.providerId)) {
          providersRef.current = providersRef.current.map((p) =>
            p.id === row.providerId
              ? { ...p, requests: p.requests + 1, errorRate: p.requests + 1 ? (p.errorRate * p.requests + (row.success ? 0 : 1)) / (p.requests + 1) : 0 }
              : p
          );
          setProviders(providersRef.current);
          const id = 'p' + (++pulseIdRef.current);
          const pulse: Pulse = { id, providerId: row.providerId, success: row.success };
          pulsesRef.current = [...pulsesRef.current.slice(-(MAX_PROVIDER_PULSES * 4)), pulse];
          setPulses(pulsesRef.current);
          const t = setTimeout(() => {
            timers.delete(t);
            pulsesRef.current = pulsesRef.current.filter((x) => x.id !== id);
            setPulses(pulsesRef.current);
          }, PULSE_MS);
          timers.add(t);
        }
        if (activeRoutesRef.current.some((a) => a.id === row.id)) {
          activeRoutesRef.current = activeRoutesRef.current.filter((a) => a.id !== row.id);
          setActiveRoutes(activeRoutesRef.current);
        }
      },
      (row) => {
        if (cancelled || !row.providerId || !providersRef.current.some((p) => p.id === row.providerId)) return;
        activeRoutesRef.current = [
          ...activeRoutesRef.current.filter((a) => a.id !== row.requestId).slice(-(MAX_ACTIVE_ROUTES - 1)),
          { id: row.requestId, providerId: row.providerId, startedAt: Date.now(), ttftMs: row.ttftMs ?? 0 },
        ];
        setActiveRoutes(activeRoutesRef.current);
      },
    );

    // Safety sweep: drop active routes whose completion event never arrived
    // (lost connection mid-request), so lights never stay stuck on.
    const sweep = setInterval(() => {
      const cutoff = Date.now() - ACTIVE_ROUTE_TIMEOUT_MS;
      if (!activeRoutesRef.current.some((a) => a.startedAt < cutoff)) return;
      activeRoutesRef.current = activeRoutesRef.current.filter((a) => a.startedAt >= cutoff);
      setActiveRoutes(activeRoutesRef.current);
    }, 30_000);

    return () => {
      cancelled = true;
      unsubscribe();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      clearInterval(sweep);
    };
  }, [snapshot]);

  // ── Lightweight provider health refresh (30s) ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const poll = setInterval(() => {
      api.get<{ providers: Array<{ id: string; health: string; enabled: boolean }> }>('/api/admin/providers')
        .then((r) => {
          if (cancelled) return;
          const healthMap = new Map(r.providers.map((p) => [p.id, p]));
          providersRef.current = providersRef.current.filter((p) => healthMap.has(p.id)).map((p) => {
            const h = healthMap.get(p.id);
            return h ? { ...p, health: h.health as RoutingProviderShape['health'], enabled: h.enabled } : p;
          });
          setProviders(providersRef.current);
        })
        .catch(() => { /* keep last known health */ });
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  return {
    snapshot,
    live: live ?? snapshot?.summary ?? EMPTY_SUMMARY,
    recent,
    providers,
    pulses,
    activeRoutes,
    loading,
    error,
  };
}

const EMPTY_SUMMARY: StatsSummaryShape = {
  totalRequests: 0, successfulRequests: 0, failedRequests: 0, successRate: 0,
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  averageLatencyMs: 0, p95LatencyMs: 0, averageTtftMs: null, p95TtftMs: null,
  cacheHitRate: 0, gatewayCacheHitRate: 0, fallbackRate: 0,
};
