// Dashboard page.
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { PageHeader } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
import { formatNumber, formatPercent, formatDateTime } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Link } from 'react-router-dom';
import { Plus, Network, Layers, KeyRound, Activity } from 'lucide-react';

interface DashData {
  today: { total: number; success: number; failed: number; totalTokens: number };
  providers: Array<{ id: string; name: string; slug: string; type: string; health: string; enabled: boolean }>;
  recentFailures: Array<{ id: string; createdAt: string; requestedModel: string; errorType: string | null; errorMessage: string | null; httpStatus: number }>;
  models: Array<{ id: string; publicModelId: string; upstreamModelId: string; providerId: string; providerName: string | null; state: string; attempts: number; failures: number; lastFailureAt: string | null; lastFailureReason: string | null }>;
  combos: Array<{ id: string; publicModelId: string; enabled: boolean; state: string; readyMembers: number; memberCount: number; reasons: string[] }>;
}

const healthVariant = (state: string) => state === 'ready' || state === 'healthy' ? 'success' as const : state === 'disabled' ? 'secondary' as const : 'destructive' as const;

export function Dashboard() {
  const [data, setData] = useState<DashData | null>(null);
  useEffect(() => { api.get<DashData>('/api/admin/dashboard').then(setData).catch(() => setData(null)); }, []);
  if (!data) return <div className="text-muted-foreground">Loading…</div>;
  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Operational summary for today"
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm"><Link to="/providers"><Plus className="mr-1 h-4 w-4" /> Provider</Link></Button>
            <Button asChild variant="outline" size="sm"><Link to="/combos"><Layers className="mr-1 h-4 w-4" /> Combo</Link></Button>
            <Button asChild variant="outline" size="sm"><Link to="/api-keys"><KeyRound className="mr-1 h-4 w-4" /> API Key</Link></Button>
          </div>
        }
      />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Requests today</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatNumber(data.today.total)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Success rate</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{data.today.total ? formatPercent(data.today.success / data.today.total) : '—'}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Failed</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatNumber(data.today.failed)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Tokens today</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatNumber(data.today.totalTokens)}</CardContent></Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Provider health</CardTitle><CardDescription>{data.providers.length} configured</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {data.providers.length === 0 && <p className="text-sm text-muted-foreground">No providers yet. <Link to="/providers" className="text-primary">Add one</Link>.</p>}
            {data.providers.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded border p-2 text-sm">
                <div className="flex min-w-0 items-center gap-2"><Network className="h-4 w-4 shrink-0 text-muted-foreground" /><Link className="truncate font-medium text-primary hover:underline" to={`/providers?providerId=${encodeURIComponent(p.id)}`}>{p.name}</Link><span className="hidden text-xs text-muted-foreground sm:inline">{p.slug}</span><Badge variant="outline" className="ml-2">{p.type}</Badge></div>
                <Badge variant={healthVariant(p.health)}>{p.health}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Recent failures</CardTitle><CardDescription>Today</CardDescription></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {data.recentFailures.length === 0 && <p className="text-muted-foreground">No failures today.</p>}
            {data.recentFailures.map((f) => (
              <div key={f.id} className="flex items-center justify-between border-b py-1 last:border-0">
                <div><span className="font-mono text-xs">{f.requestedModel}</span><div className="text-xs text-muted-foreground">{f.errorType ?? `HTTP ${f.httpStatus}`} — {f.errorMessage?.slice(0, 60)}</div></div>
                <span className="text-xs text-muted-foreground">{formatDateTime(f.createdAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" /> Health center</CardTitle><CardDescription>Passive status from recent traffic; no active provider polling.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div><div className="mb-2 text-sm font-medium">Combos</div><div className="space-y-2">{data.combos.length === 0 ? <p className="text-sm text-muted-foreground">No combos configured.</p> : data.combos.map((combo) => <div key={combo.id} className="flex items-center justify-between rounded border p-2 text-sm"><div className="min-w-0"><Link className="font-mono text-xs text-primary hover:underline" to="/combos">{combo.publicModelId}</Link><div className="text-xs text-muted-foreground">{combo.readyMembers}/{combo.memberCount} members ready{combo.reasons.length > 0 ? ` · ${combo.reasons.join(', ')}` : ''}</div></div><Badge variant={healthVariant(combo.state)}>{combo.state}</Badge></div>)}</div></div>
          <div><div className="mb-2 text-sm font-medium">Models</div><div className="max-h-64 space-y-2 overflow-auto">{data.models.length === 0 ? <p className="text-sm text-muted-foreground">No models imported.</p> : data.models.map((model) => <div key={model.id} className="flex items-center justify-between rounded border p-2 text-sm"><div className="min-w-0"><Link className="font-mono text-xs text-primary hover:underline" to={`/models?providerId=${encodeURIComponent(model.providerId)}`}>{model.publicModelId}</Link><div className="truncate text-xs text-muted-foreground">{model.providerName ?? 'Unknown provider'}{model.lastFailureReason ? ` · last: ${model.lastFailureReason}` : ''}</div></div><Badge variant={healthVariant(model.state)}>{model.state}</Badge></div>)}</div></div>
        </CardContent>
      </Card>
    </div>
  );
}
