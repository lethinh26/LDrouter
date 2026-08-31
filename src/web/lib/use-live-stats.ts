// Realtime statistics data layer: SSE subscription + incremental aggregation.
// All data logic lives here — UI components only render what this hook returns.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export type Preset = 'today' | '7d' | '30d';

export interface StatsSummaryShape {
  totalRequests: number; successfulRequests: number; failedRequests: number; successRate: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  averageLatencyMs: number; p95LatencyMs: number;
  averageTtftMs: number | null; p95TtftMs: number | null;
  cacheHitRate: number; gatewayCacheHitRate: number; fallbackRate: number;
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
  cacheReadTokens: number; totalLatencyMs: number;
}

export interface Pulse { id: string; providerId: string; success: boolean }

export interface StatsSnapshot {
  range: { from: string; to: string; bucket: string };
  summary: StatsSummaryShape;
  previous: StatsSummaryShape;
  series: Array<{ t: string; requests: number; errors: number; inputTokens: number; outputTokens: number; avgLatency: number; cacheRead: number }>;
  topModels: Array<{ publicId: string; requests: number; errorRate: number; totalTokens: number }>;
  topApiKeys: Array<{ name: string; requests: number; totalTokens: number }>;
  recent: LiveRequestShape[];
  providers: RoutingProviderShape[];
}

const RECONNECT_MS = 3000;
const PULSE_MS = 1600; // animation duration
const MAX_RECENT = 10;
const MAX_PROVIDER_PULSES = 3;

export interface UseLiveStatsResult {
  snapshot: StatsSnapshot | null;
  live: StatsSummaryShape; // snapshot summary + live increments
  recent: LiveRequestShape[];
  providers: RoutingProviderShape[];
  pulses: Pulse[];
  loading: boolean;
  error: string | null;
}

/** Merge a live SSE row into an incremental summary (mutates and returns it). */
function applyLiveSummary(s: StatsSummaryShape, r: LiveRequestShape): StatsSummaryShape {
  return {
    ...s,
    totalRequests: s.totalRequests + 1,
    successfulRequests: s.successfulRequests + (r.success ? 1 : 0),
    failedRequests: s.failedRequests + (r.success ? 0 : 1),
    successRate: s.totalRequests + 1 ? (s.successfulRequests + (r.success ? 1 : 0)) / (s.totalRequests + 1) : 0,
    inputTokens: s.inputTokens + r.inputTokens,
    outputTokens: s.outputTokens + r.outputTokens,
    totalTokens: s.totalTokens + r.inputTokens + r.outputTokens,
    cacheReadTokens: s.cacheReadTokens + r.cacheReadTokens,
    averageLatencyMs: (s.averageLatencyMs * s.totalRequests + r.totalLatencyMs) / (s.totalRequests + 1),
  };
}

export function useLiveStats(preset: Preset): UseLiveStatsResult {
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [live, setLive] = useState<StatsSummaryShape | null>(null);
  const [recent, setRecent] = useState<LiveRequestShape[]>([]);
  const [providers, setProviders] = useState<RoutingProviderShape[]>([]);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refs: read by the SSE effect without re-subscribing.
  const providersRef = useRef<RoutingProviderShape[]>([]);
  const liveRef = useRef<StatsSummaryShape | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const sinceRef = useRef<number>(Date.now());
  const pulseIdRef = useRef(0);
  const pulsesRef = useRef<Pulse[]>([]);

  // ── Snapshot fetch (on mount + preset change) ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    seenIdsRef.current = new Set();
    sinceRef.current = Date.now();
    api.get<StatsSnapshot>(`/api/admin/stats?preset=${preset}`)
      .then((r) => {
        if (cancelled) return;
        setSnapshot(r);
        setLive(r.summary);
        liveRef.current = r.summary;
        setRecent(r.recent);
        setProviders(r.providers);
        providersRef.current = r.providers;
        for (const row of r.recent) seenIdsRef.current.add(row.id);
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
    let cancelled = false;
    let es: EventSource | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const connect = (): void => {
      if (cancelled) return;
      es = new EventSource(`/api/admin/requests/stream?since=${sinceRef.current}`);
      es.addEventListener('request', (ev) => {
        if (cancelled) return;
        try {
          const row = JSON.parse((ev as MessageEvent).data as string) as LiveRequestShape;
          const seenMs = new Date(row.createdAt).getTime();
          if (Number.isFinite(seenMs)) sinceRef.current = Math.max(sinceRef.current, seenMs);
          if (seenIdsRef.current.has(row.id)) return; // replay duplicate
          seenIdsRef.current.add(row.id);

          // Live summary increments.
          if (liveRef.current) setLive(applyLiveSummary(liveRef.current, row));
          // Recent list (cap).
          setRecent((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            return [row, ...prev].slice(0, MAX_RECENT);
          });
          // Provider traffic increment + pulse.
          if (row.providerId) {
            providersRef.current = providersRef.current.map((p) =>
              p.id === row.providerId
                ? { ...p, requests: p.requests + 1, errorRate: p.requests + 1 ? (p.errorRate * p.requests + (row.success ? 0 : 1)) / (p.requests + 1) : 0 }
                : p
            );
            setProviders(providersRef.current);
            const id = `p${++pulseIdRef.current}`;
            const pulse: Pulse = { id, providerId: row.providerId, success: row.success };
            pulsesRef.current = [...pulsesRef.current.slice(-(MAX_PROVIDER_PULSES * 4)), pulse];
            setPulses(pulsesRef.current);
            const t = setTimeout(() => {
              pulsesRef.current = pulsesRef.current.filter((x) => x.id !== id);
              setPulses(pulsesRef.current);
            }, PULSE_MS);
            timers.add(t);
          }
        } catch { /* malformed event — ignore */ }
      });
      es.onerror = () => {
        es?.close();
        es = null;
        if (!cancelled) timers.add(setTimeout(connect, RECONNECT_MS));
      };
    };

    connect();

    return () => {
      cancelled = true;
      es?.close();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // ── Lightweight provider health refresh (30s) ─────────────────────────────
  useEffect(() => {
    const poll = setInterval(() => {
      api.get<{ providers: Array<{ id: string; health: string; enabled: boolean }> }>('/api/admin/providers')
        .then((r) => {
          const healthMap = new Map(r.providers.map((p) => [p.id, p]));
          providersRef.current = providersRef.current.map((p) => {
            const h = healthMap.get(p.id);
            return h ? { ...p, health: h.health as RoutingProviderShape['health'], enabled: h.enabled } : p;
          });
          setProviders(providersRef.current);
        })
        .catch(() => { /* keep last known health */ });
    }, 30_000);
    return () => clearInterval(poll);
  }, []);

  return {
    snapshot,
    live: live ?? snapshot?.summary ?? EMPTY_SUMMARY,
    recent,
    providers,
    pulses,
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
