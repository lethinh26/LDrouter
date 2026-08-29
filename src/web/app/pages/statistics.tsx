// Statistics page.
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { api } from '../../lib/api';
import { formatNumber, formatPercent, formatLatencyMs } from '../../lib/utils';

interface Stats {
  range: { from: string; to: string; bucket: string };
  summary: {
    totalRequests: number; successfulRequests: number; failedRequests: number; successRate: number;
    inputTokens: number; outputTokens: number; totalTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
    averageLatencyMs: number; p95LatencyMs: number;
    averageTtftMs: number | null; p95TtftMs: number | null;
    cacheHitRate: number; gatewayCacheHitRate: number; fallbackRate: number;
  };
  series: Array<{ t: string; requests: number; errors: number; inputTokens: number; outputTokens: number }>;
  topModels: Array<{ publicId: string; requests: number; errorRate: number; totalTokens: number }>;
  topApiKeys: Array<{ name: string; requests: number; totalTokens: number }>;
  topProviders: Array<{ name: string; slug: string; requests: number; errorRate: number }>;
}

export function Statistics() {
  const [preset, setPreset] = useState<'today' | '7d' | '30d'>('7d');
  const [data, setData] = useState<Stats | null>(null);
  useEffect(() => { api.get<Stats>(`/api/admin/stats?preset=${preset}`).then(setData).catch(() => setData(null)); }, [preset]);
  if (!data) return <div className="text-muted-foreground">Loading…</div>;
  const s = data.summary;
  return (
    <div>
      <PageHeader title="Statistics" description="Aggregated metrics for the selected range" actions={
        <Tabs value={preset} onValueChange={(v) => setPreset(v as 'today' | '7d' | '30d')}>
          <TabsList>
            <TabsTrigger value="today">Today</TabsTrigger>
            <TabsTrigger value="7d">7 days</TabsTrigger>
            <TabsTrigger value="30d">30 days</TabsTrigger>
          </TabsList>
        </Tabs>
      } />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Requests</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatNumber(s.totalRequests)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Success rate</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatPercent(s.successRate)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Total tokens</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatNumber(s.totalTokens)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Cache hit rate</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatPercent(s.cacheHitRate)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Avg latency</CardTitle></CardHeader><CardContent>{formatLatencyMs(s.averageLatencyMs)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">p95 latency</CardTitle></CardHeader><CardContent>{formatLatencyMs(s.p95LatencyMs)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Avg TTFT</CardTitle></CardHeader><CardContent>{s.averageTtftMs ? formatLatencyMs(s.averageTtftMs) : '—'}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Fallback rate</CardTitle></CardHeader><CardContent>{formatPercent(s.fallbackRate)}</CardContent></Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Top models</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Requests</TableHead><TableHead>Errors</TableHead><TableHead>Tokens</TableHead></TableRow></TableHeader>
              <TableBody>
                {data.topModels.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground text-center">No data</TableCell></TableRow>}
                {data.topModels.map((m) => (
                  <TableRow key={m.publicId}>
                    <TableCell className="font-mono text-xs">{m.publicId}</TableCell>
                    <TableCell>{formatNumber(m.requests)}</TableCell>
                    <TableCell>{formatPercent(m.errorRate)}</TableCell>
                    <TableCell>{formatNumber(m.totalTokens)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Top API keys</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Requests</TableHead><TableHead>Tokens</TableHead></TableRow></TableHeader>
              <TableBody>
                {data.topApiKeys.length === 0 && <TableRow><TableCell colSpan={3} className="text-muted-foreground text-center">No data</TableCell></TableRow>}
                {data.topApiKeys.map((k, i) => (
                  <TableRow key={i}><TableCell>{k.name}</TableCell><TableCell>{formatNumber(k.requests)}</TableCell><TableCell>{formatNumber(k.totalTokens)}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">Series (requests / errors over time)</CardTitle><CardDescription>Buckets: {data.range.bucket}</CardDescription></CardHeader>
        <CardContent>
          <div className="grid grid-cols-12 gap-1 text-xs">
            {data.series.map((s) => (
              <div key={s.t} className="flex flex-col items-center" title={`${s.t}: ${s.requests} req, ${s.errors} err`}>
                <div className="w-full bg-primary/80" style={{ height: `${Math.min(80, s.requests * 4)}px` }} />
                <div className="text-[10px] text-muted-foreground">{s.t.slice(5, 10)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
