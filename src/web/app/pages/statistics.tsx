// Statistics page: production-grade realtime monitoring dashboard.
// Summary cards, routing flow, recent requests, top models/keys, bottom metrics.
import { useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { formatNumber, formatPercent } from '../../lib/utils';
import { useLiveStats, type Preset } from '../../lib/use-live-stats';
import { SummaryCard } from '../../components/statistics/summary-card';
import { RoutingFlow } from '../../components/statistics/routing-flow';
import { RecentRequests } from '../../components/statistics/recent-requests';
import { BottomMetrics } from '../../components/statistics/bottom-metrics';
import { Activity, CheckCircle2, Cpu, Database, Clock, Gauge, Route, TrendingUp } from 'lucide-react';

export function Statistics() {
  const [preset, setPreset] = useState<Preset>('7d');
  const { snapshot, live, recent, providers, pulses, activeRoutes, loading, error } = useLiveStats(preset);

  if (loading) return <div className="text-muted-foreground">Loading…</div>;
  if (error || !snapshot) return <div className="text-destructive">Failed to load statistics: {error ?? 'unknown error'}</div>;

  const s = live;
  const prev = snapshot.previous;
  const series = snapshot.series;

  // Deltas: (current - previous) / previous for each summary metric.
  function delta(cur: number, prev: number): number | undefined {
    return prev > 0 ? (cur - prev) / prev : undefined;
  }

  // Sparkline data: extract requests per bucket (for summary cards).
  const sparkRequests = series.map((b) => b.requests);
  const sparkLatency = series.map((b) => b.avgLatency);

  return (
    <div>
      <PageHeader title="Statistics" description="Real-time monitoring dashboard" actions={
        <Tabs value={preset} onValueChange={(v) => void setPreset(v as Preset)}>
          <TabsList>
            <TabsTrigger value="today">Today</TabsTrigger>
            <TabsTrigger value="7d">7 days</TabsTrigger>
            <TabsTrigger value="30d">30 days</TabsTrigger>
          </TabsList>
        </Tabs>
      } />

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <SummaryCard icon={Activity} label="Requests" value={s.totalRequests} delta={delta(s.totalRequests, prev.totalRequests)} sparkData={sparkRequests} />
        <SummaryCard icon={CheckCircle2} label="Success rate" format="percent" value={s.successRate} delta={delta(s.successRate, prev.successRate)} sparkData={sparkRequests} sparkStroke="stroke-emerald-500" />
        <SummaryCard icon={Cpu} label="Total tokens" value={s.totalTokens} delta={delta(s.totalTokens, prev.totalTokens)} sparkData={series.map((b) => b.inputTokens + b.outputTokens)} />
        <SummaryCard icon={Database} label="Cache hit rate" format="percent" value={s.cacheHitRate} delta={delta(s.cacheHitRate, prev.cacheHitRate)} sparkData={series.map((b) => b.cacheRead)} />
        <SummaryCard icon={Clock} label="Avg latency" format="latency" value={s.averageLatencyMs} delta={delta(s.averageLatencyMs, prev.averageLatencyMs)} deltaInverse sparkData={sparkLatency} sparkStroke="stroke-amber-500" />
        <SummaryCard icon={Gauge} label="p95 latency" format="latency" value={s.p95LatencyMs} />
        <SummaryCard icon={TrendingUp} label="Avg TTFT" format="latency" value={s.averageTtftMs ?? 0} />
        <SummaryCard icon={Route} label="Fallback rate" format="percent" value={s.fallbackRate} delta={delta(s.fallbackRate, prev.fallbackRate)} deltaInverse />
      </div>

      {/* Routing flow */}
      <div className="mt-6">
        <RoutingFlow liveRequests={s.totalRequests} successRate={s.successRate} providers={providers} pulses={pulses} activeRoutes={activeRoutes} />
      </div>

      {/* Recent Requests + Top Models + Top API Keys */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentRequests rows={recent} />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Top Models</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Req</TableHead><TableHead>Errors</TableHead><TableHead>Tokens</TableHead></TableRow></TableHeader>
                <TableBody>
                  {snapshot.topModels.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground text-center">No data</TableCell></TableRow>}
                  {snapshot.topModels.map((m) => (
                    <TableRow key={m.publicId}>
                      <TableCell className="font-mono text-xs">{m.publicId}</TableCell>
                      <TableCell className="text-xs">{formatNumber(m.requests)}</TableCell>
                      <TableCell className="text-xs"><span className={m.errorRate > 0.1 ? 'text-destructive' : 'text-muted-foreground'}>{formatPercent(m.errorRate)}</span></TableCell>
                      <TableCell className="text-xs">{formatNumber(m.totalTokens)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Top API Keys</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Requests</TableHead><TableHead>Tokens</TableHead></TableRow></TableHeader>
                <TableBody>
                  {snapshot.topApiKeys.length === 0 && <TableRow><TableCell colSpan={3} className="text-muted-foreground text-center">No data</TableCell></TableRow>}
                  {snapshot.topApiKeys.map((k, i) => (
                    <TableRow key={i}><TableCell className="text-xs">{k.name}</TableCell><TableCell className="text-xs">{formatNumber(k.requests)}</TableCell><TableCell className="text-xs">{formatNumber(k.totalTokens)}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Bottom metrics */}
      <div className="mt-6">
        <BottomMetrics successRate={s.successRate} averageLatencyMs={s.averageLatencyMs} latencySpark={sparkLatency} />
      </div>
    </div>
  );
}