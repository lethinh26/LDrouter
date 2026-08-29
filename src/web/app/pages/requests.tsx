// Requests page: paginated list with filters.
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import { api } from '../../lib/api';
import { formatDateTime, formatLatencyMs, formatNumber, shortId } from '../../lib/utils';

interface RequestRow {
  id: string; createdAt: string; requestedModel: string; finalModelPublicId: string | null;
  protocol: 'openai' | 'anthropic'; endpoint: string; streaming: boolean; httpStatus: number;
  success: boolean; totalLatencyMs: number; ttftMs: number | null; inputTokens: number;
  outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  totalTokens: number; attemptsCount: number; errorType: string | null; errorMessage: string | null;
  apiKeyName: string | null; clientIp: string; gatewayCacheHit: boolean;
}

export function Requests() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({ success: 'all', protocol: 'all', streaming: 'all', model: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ request: RequestRow; attempts: Array<Record<string, unknown>> } | null>(null);
  const limit = 50;

  const reload = useCallback(async () => {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    if (filters.success !== 'all') q.set('success', filters.success);
    if (filters.protocol !== 'all') q.set('protocol', filters.protocol);
    if (filters.streaming !== 'all') q.set('streaming', filters.streaming);
    if (filters.model) q.set('requestedModel', filters.model);
    const r = await api.get<{ total: number; requests: RequestRow[] }>(`/api/admin/requests?${q.toString()}`);
    setRows(r.requests); setTotal(r.total);
  }, [offset, filters]);
  useEffect(() => { void reload(); }, [reload]);

  const open = async (id: string) => {
    setOpenId(id);
    const r = await api.get<{ request: RequestRow; attempts: Array<Record<string, unknown>> }>(`/api/admin/requests/${id}`);
    setDetail(r);
  };

  return (
    <div>
      <PageHeader title="Requests" description={`${total} matching · server-side paginated`} />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={filters.success} onValueChange={(v) => { setOffset(0); setFilters({ ...filters, success: v }); }}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="true">Success</SelectItem><SelectItem value="false">Failed</SelectItem></SelectContent>
            </Select>
            <Select value={filters.protocol} onValueChange={(v) => { setOffset(0); setFilters({ ...filters, protocol: v }); }}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any protocol</SelectItem><SelectItem value="openai">OpenAI</SelectItem><SelectItem value="anthropic">Anthropic</SelectItem></SelectContent>
            </Select>
            <Select value={filters.streaming} onValueChange={(v) => { setOffset(0); setFilters({ ...filters, streaming: v }); }}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any</SelectItem><SelectItem value="true">Streaming</SelectItem><SelectItem value="false">Non-stream</SelectItem></SelectContent>
            </Select>
            <Input className="max-w-xs" placeholder="Model contains…" value={filters.model} onChange={(e) => { setOffset(0); setFilters({ ...filters, model: e.target.value }); }} />
          </div>
          <CardTitle className="mt-3 text-base">Results</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead><TableHead>Status</TableHead><TableHead>Requested</TableHead>
                <TableHead>Final</TableHead><TableHead>Tokens</TableHead><TableHead>Latency</TableHead>
                <TableHead>Attempts</TableHead><TableHead>Key</TableHead><TableHead>IP</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">No requests yet.</TableCell></TableRow>}
              {rows.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => open(r.id)}>
                  <TableCell className="text-xs">{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell>{r.success ? <Badge variant="success">{r.httpStatus}</Badge> : <Badge variant="destructive">{r.httpStatus}</Badge>}</TableCell>
                  <TableCell className="font-mono text-xs">{r.requestedModel}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.finalModelPublicId ?? '—'}</TableCell>
                  <TableCell className="text-xs">{formatNumber(r.inputTokens + r.outputTokens)} {r.cacheReadTokens ? <span className="text-amber-600">(+{r.cacheReadTokens} cache)</span> : null}</TableCell>
                  <TableCell className="text-xs">{formatLatencyMs(r.totalLatencyMs)}{r.ttftMs ? <span className="text-muted-foreground"> · ttft {r.ttftMs}ms</span> : null}</TableCell>
                  <TableCell className="text-xs">{r.attemptsCount}{r.gatewayCacheHit ? <Badge variant="secondary" className="ml-1">cache</Badge> : null}</TableCell>
                  <TableCell className="text-xs">{r.apiKeyName ?? '—'}</TableCell>
                  <TableCell className="text-xs">{r.clientIp}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="ghost">View</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</Button>
              <Button size="sm" variant="outline" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!openId} onOpenChange={(o) => { if (!o) { setOpenId(null); setDetail(null); } }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Request {shortId(openId, 16)}</DialogTitle></DialogHeader>
          {!detail ? <div className="text-muted-foreground">Loading…</div> : (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div><div className="text-muted-foreground text-xs">Status</div>{detail.request.success ? <Badge variant="success">{detail.request.httpStatus}</Badge> : <Badge variant="destructive">{detail.request.httpStatus}</Badge>}</div>
                <div><div className="text-muted-foreground text-xs">Latency</div>{formatLatencyMs(detail.request.totalLatencyMs)}</div>
                <div><div className="text-muted-foreground text-xs">Tokens</div>in {formatNumber(detail.request.inputTokens)} · out {formatNumber(detail.request.outputTokens)} · cache {formatNumber(detail.request.cacheReadTokens)}</div>
                <div><div className="text-muted-foreground text-xs">Attempts</div>{detail.request.attemptsCount}</div>
              </div>
              {detail.request.errorType && (
                <div className="rounded border border-destructive/40 bg-destructive/10 p-2">
                  <div className="text-xs text-muted-foreground">Error</div>
                  <div className="font-mono text-xs">{detail.request.errorType}: {detail.request.errorMessage}</div>
                </div>
              )}
              {detail.attempts.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground">Attempts</div>
                  <Table>
                    <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Provider</TableHead><TableHead>Model</TableHead><TableHead>Status</TableHead><TableHead>Latency</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {detail.attempts.map((a) => (
                        <TableRow key={a.id as string}>
                          <TableCell>{a.attemptNumber as number}</TableCell>
                          <TableCell>{a.providerName as string}</TableCell>
                          <TableCell className="font-mono text-xs">{a.modelPublicId as string}</TableCell>
                          <TableCell>{a.success ? <Badge variant="success">{String(a.statusCode ?? 'OK')}</Badge> : <Badge variant="destructive">{String(a.statusCode ?? 'err')}</Badge>}</TableCell>
                          <TableCell className="text-xs">{formatLatencyMs(a.latencyMs as number)}</TableCell>
                          <TableCell className="text-xs">{(a.failureReason as string) ?? a.selectionReason as string}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
