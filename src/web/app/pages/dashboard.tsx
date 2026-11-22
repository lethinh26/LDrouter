// Dashboard page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { PageHeader, Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
import { formatNumber, formatPercent, formatDateTime } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Boxes, ClipboardList, KeyRound, Layers, Network, Plus, RefreshCw } from 'lucide-react';

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
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const mountedRef = useRef(false);

  const loadDashboard = useCallback(async () => {
    setLoadState('loading');
    try {
      const result = await api.get<DashData>('/api/admin/dashboard');
      if (!mountedRef.current) return;
      setData(result);
      setLoadState('ready');
    } catch {
      if (!mountedRef.current) return;
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadDashboard();
    return () => { mountedRef.current = false; };
  }, [loadDashboard]);

  const quickLinks = (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" size="sm"><Link to="/providers"><Plus className="mr-1 h-4 w-4" /> Provider</Link></Button>
      <Button asChild variant="outline" size="sm"><Link to="/models"><Boxes className="mr-1 h-4 w-4" /> Models</Link></Button>
      <Button asChild variant="outline" size="sm"><Link to="/combos"><Layers className="mr-1 h-4 w-4" /> Combos</Link></Button>
      <Button asChild variant="outline" size="sm"><Link to="/api-keys"><KeyRound className="mr-1 h-4 w-4" /> API Keys</Link></Button>
      <Button asChild variant="outline" size="sm"><Link to="/requests"><ClipboardList className="mr-1 h-4 w-4" /> Requests</Link></Button>
    </div>
  );

  if (loadState === 'loading') {
    return (
      <>
        <p role="status" aria-live="polite" className="sr-only">Loading dashboard…</p>
        <div aria-busy="true">
          <PageHeader title="Dashboard" description="Operational summary for today" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => <Card key={index}><CardHeader className="pb-2"><Skeleton className="h-4 w-28" /></CardHeader><CardContent><Skeleton className="h-8 w-20" /></CardContent></Card>)}
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 2 }, (_, index) => <Card key={index}><CardHeader><Skeleton className="h-5 w-36" /><Skeleton className="h-3 w-24" /></CardHeader><CardContent className="space-y-3">{Array.from({ length: 3 }, (_, row) => <Skeleton key={row} className="h-12 w-full" />)}</CardContent></Card>)}
          </div>
          <Card className="mt-6"><CardHeader><Skeleton className="h-5 w-36" /></CardHeader><CardContent className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></CardContent></Card>
        </div>
      </>
    );
  }

  if (loadState === 'error' || !data) {
    return (
      <div>
        <PageHeader title="Dashboard" description="Operational summary for today" />
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base">Dashboard unavailable</CardTitle>
            <CardDescription role="alert">Could not load the operational summary. Your configuration and request data have not been changed.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void loadDashboard()}><RefreshCw className="mr-2 h-4 w-4" /> Try again</Button>
            <span className="text-sm text-muted-foreground">You can still open an administration page directly.</span>
            {quickLinks}
          </CardContent>
        </Card>
      </div>
    );
  }

  const isFreshInstall = data.today.total === 0 && data.providers.length === 0 && data.models.length === 0 && data.combos.length === 0;

  return (
    <div>
      <PageHeader title="Dashboard" description="Operational summary for today" actions={quickLinks} />

      {isFreshInstall && (
        <Card className="mb-6 border-primary/20 bg-primary/[0.03]">
          <CardHeader>
            <CardTitle className="text-base">Your gateway is ready to configure</CardTitle>
            <CardDescription>Start by connecting an upstream provider, importing models, and creating an API key for your applications.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild size="sm"><Link to="/providers"><Plus className="mr-2 h-4 w-4" /> Add your first provider</Link></Button>
            <Button asChild size="sm" variant="outline"><Link to="/api-keys">Create an API key <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Requests today</CardTitle></CardHeader><CardContent className="text-2xl font-semibold tabular-nums">{formatNumber(data.today.total)}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Success rate</CardTitle></CardHeader><CardContent className="text-2xl font-semibold tabular-nums">{data.today.total ? formatPercent(data.today.success / data.today.total) : '—'}</CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Failed</CardTitle></CardHeader><CardContent className="flex items-end justify-between"><span className="text-2xl font-semibold tabular-nums">{formatNumber(data.today.failed)}</span><Link to="/requests?status=failed" className="text-xs text-primary hover:underline">View failures</Link></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Tokens today</CardTitle></CardHeader><CardContent className="text-2xl font-semibold tabular-nums">{formatNumber(data.today.totalTokens)}</CardContent></Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Provider health</CardTitle><CardDescription>{data.providers.length} configured</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {data.providers.length === 0 && <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No providers configured yet. <Link to="/providers" className="font-medium text-primary hover:underline">Connect a provider</Link> to start routing requests.</div>}
            {data.providers.map((provider) => (
              <div key={provider.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <div className="flex min-w-0 items-center gap-2"><Network className="h-4 w-4 shrink-0 text-muted-foreground" /><Link className="truncate font-medium text-primary hover:underline" to="/providers">{provider.name}</Link><span className="hidden text-xs text-muted-foreground sm:inline">{provider.slug}</span><Badge variant="outline" className="ml-1 shrink-0">{provider.type}</Badge></div>
                <Badge variant={healthVariant(provider.health)}>{provider.health}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2"><div><CardTitle className="text-base">Recent failures</CardTitle><CardDescription>Latest failed requests today</CardDescription></div><Button asChild variant="ghost" size="sm"><Link to="/requests?status=failed">View all <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {data.recentFailures.length === 0 && <div className="rounded-lg border border-dashed p-4 text-muted-foreground">No failed requests today. <Link to="/requests" className="font-medium text-primary hover:underline">Browse request history</Link>.</div>}
            {data.recentFailures.map((failure) => (
              <Link key={failure.id} to={`/requests?searchBy=id&search=${encodeURIComponent(failure.id)}`} className="flex items-center justify-between gap-3 rounded-md border-b px-2 py-2 last:border-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="min-w-0"><div className="truncate font-mono text-xs">{failure.requestedModel}</div><div className="truncate text-xs text-muted-foreground">{failure.errorType ?? `HTTP ${failure.httpStatus}`}{failure.errorMessage ? ` — ${failure.errorMessage.slice(0, 60)}` : ''}</div></div>
                <div className="shrink-0 text-right"><Badge variant="destructive">{failure.httpStatus}</Badge><div className="mt-1 text-[11px] text-muted-foreground">{formatDateTime(failure.createdAt)}</div></div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" /> Health center</CardTitle><CardDescription>Passive status from recent traffic; no active provider polling.</CardDescription></CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <section aria-label="Combo health"><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium">Combos</h3><Link to="/combos" className="text-xs text-primary hover:underline">Manage</Link></div><div className="space-y-2">{data.combos.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No combos configured.</p> : data.combos.map((combo) => <div key={combo.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"><div className="min-w-0"><Link className="font-mono text-xs text-primary hover:underline" to="/combos">{combo.publicModelId}</Link><div className="text-xs text-muted-foreground">{combo.readyMembers}/{combo.memberCount} members ready{combo.reasons.length > 0 ? ` · ${combo.reasons.join(', ')}` : ''}</div></div><Badge variant={healthVariant(combo.state)}>{combo.state}</Badge></div>)}</div></section>
          <section aria-label="Model health"><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium">Models</h3><Link to="/models" className="text-xs text-primary hover:underline">Manage</Link></div><div className="max-h-64 space-y-2 overflow-auto">{data.models.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No models imported. <Link to="/models" className="text-primary hover:underline">Discover models</Link>.</p> : data.models.map((model) => <div key={model.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"><div className="min-w-0"><Link className="font-mono text-xs text-primary hover:underline" to="/models">{model.publicModelId}</Link><div className="truncate text-xs text-muted-foreground">{model.providerName ?? 'Unknown provider'}{model.lastFailureReason ? ` · last: ${model.lastFailureReason}` : ''}</div></div><Badge variant={healthVariant(model.state)}>{model.state}</Badge></div>)}</div></section>
        </CardContent>
      </Card>
    </div>
  );
}
