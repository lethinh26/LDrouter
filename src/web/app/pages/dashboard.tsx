// Dashboard page.
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { PageHeader } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
import { formatNumber, formatPercent, formatDateTime } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Link } from 'react-router-dom';
import { Plus, Network, Layers, KeyRound } from 'lucide-react';

interface DashData {
  today: { total: number; success: number; failed: number; totalTokens: number };
  providers: Array<{ id: string; name: string; slug: string; type: string; health: string; enabled: boolean }>;
  recentFailures: Array<{ id: string; createdAt: string; requestedModel: string; errorType: string | null; errorMessage: string | null; httpStatus: number }>;
}

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
                <div className="flex items-center gap-2"><Network className="h-4 w-4 text-muted-foreground" /><span className="font-medium">{p.name}</span><span className="text-xs text-muted-foreground">{p.slug}</span><Badge variant="outline" className="ml-2">{p.type}</Badge></div>
                <Badge variant={p.health === 'healthy' ? 'success' : p.health === 'down' ? 'destructive' : 'secondary'}>{p.health}</Badge>
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
    </div>
  );
}
