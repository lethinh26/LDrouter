// Requests page: paginated list with filters + live updates via the SSE stream.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { api } from '../../lib/api';
import { formatDateTime, formatLatencyMs, formatNumber, shortId } from '../../lib/utils';
import { Link } from 'react-router-dom';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';

interface RequestRow {
  id: string; createdAt: string; requestedModel: string; finalModelPublicId: string | null;
  finalModelUpstreamId?: string | null; resolvedTargetKind?: string; resolvedTargetId?: string | null; providerId?: string | null; providerName?: string | null; providerSlug?: string | null;
  protocol: 'openai' | 'anthropic'; endpoint: string; streaming: boolean; httpStatus: number;
  success: boolean; totalLatencyMs: number; ttftMs: number | null; inputTokens: number;
  outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  totalTokens: number; attemptsCount: number; errorType: string | null; errorMessage: string | null;
  apiKeyName: string | null; clientIp: string; gatewayCacheHit: boolean;
  requestPayload?: string | null;
  responsePayload?: string | null;
}

interface RequestDetail extends RequestRow { reproductionCurl: string; fallbackReasons: string[]; }

type Filters = { success: string; protocol: string; streaming: string; model: string };

const RECONNECT_MS = 3000;

// Client-side mirror of the list endpoint's filters, used to decide whether a
// live SSE row belongs in the currently visible (unfiltered page-0) result set.
function matchesFilters(r: RequestRow, f: Filters): boolean {
  if (f.success !== 'all' && r.success !== (f.success === 'true')) return false;
  if (f.protocol !== 'all' && r.protocol !== f.protocol) return false;
  if (f.streaming !== 'all' && r.streaming !== (f.streaming === 'true')) return false;
  if (f.model && !r.requestedModel.toLowerCase().includes(f.model.toLowerCase())) return false;
  return true;
}

export function Requests() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Filters>({ success: 'all', protocol: 'all', streaming: 'all', model: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ request: RequestDetail; attempts: Array<Record<string, unknown>> } | null>(null);
  const [detailTab, setDetailTab] = useState('overview');
  const [newCount, setNewCount] = useState(0); // live rows arrived since last reload/filter change
  const limit = 50;

  // Live-stream state: cursor (epoch ms of newest row seen), seen ids, latest filters/offset.
  const sinceRef = useRef<number>(Date.now());
  const seenIdsRef = useRef<Set<string>>(new Set());
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const offsetRef = useRef(offset); offsetRef.current = offset;

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
    // Seed the live-stream dedup set from the fresh page.
    for (const row of r.requests) seenIdsRef.current.add(row.id);
  }, [offset, filters]);
  useEffect(() => { void reload(); }, [reload]);

  // Reset the "new requests" counter whenever the visible window changes.
  useEffect(() => { setNewCount(0); }, [offset, filters]);

  // Live updates: subscribe to the SSE stream (same reconnect pattern as the
  // notification hook). Rows that match the active filters land in the table
  // immediately when viewing page 1; every arrival bumps the counter badge.
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
          const data = JSON.parse((ev as MessageEvent).data as string) as RequestRow;
          const seenMs = new Date(data.createdAt).getTime();
          if (Number.isFinite(seenMs)) sinceRef.current = Math.max(sinceRef.current, seenMs);
          if (seenIdsRef.current.has(data.id)) return; // replay duplicate — ignore
          seenIdsRef.current.add(data.id);
          setNewCount((n) => n + 1);
          if (offsetRef.current === 0 && matchesFilters(data, filtersRef.current)) {
            setRows((prev) => {
              if (prev.some((r) => r.id === data.id)) return prev;
              return [data, ...prev].slice(0, limit);
            });
            setTotal((t) => t + 1);
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

  const open = async (id: string) => {
    setOpenId(id);
    setDetailTab('overview');
    const r = await api.get<{ request: RequestDetail; attempts: Array<Record<string, unknown>> }>(`/api/admin/requests/${id}`);
    setDetail(r);
  };

  const copyText = (value: string, label: string) => {
    void navigator.clipboard.writeText(value).then(() => toast.success(`${label} copied`));
  };

  const downloadText = (value: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const payloadPreview = (value: string, limit = 12000) => {
    if (value.length <= limit) return { text: value, truncated: false };
    const half = Math.floor(limit / 2);
    return { text: `${value.slice(0, half)}\n\n… ${value.length - limit} characters hidden …\n\n${value.slice(-half)}`, truncated: true };
  };

  return (
    <div>
      <PageHeader title="Requests" description={`${total} matching · live updates`} />
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
            {newCount > 0 && (
              <Button size="sm" variant="secondary" onClick={() => { setNewCount(0); void reload(); }}>
                {newCount} new request{newCount > 1 ? 's' : ''} — refresh
              </Button>
            )}
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
        <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
          <DialogHeader><DialogTitle>Request {shortId(openId, 16)}</DialogTitle></DialogHeader>
          {!detail ? <div className="text-muted-foreground">Loading…</div> : (
            <Tabs value={detailTab} onValueChange={setDetailTab} className="min-w-0">
              <TabsList className="flex h-auto flex-wrap justify-start gap-1">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="attempts">Attempts ({detail.attempts.length})</TabsTrigger>
                <TabsTrigger value="request">Request</TabsTrigger>
                <TabsTrigger value="response">Response</TabsTrigger>
                <TabsTrigger value="replay">Replay curl</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                <div><div className="text-muted-foreground text-xs">Requested model</div><span className="font-mono text-xs">{detail.request.requestedModel}</span></div>
                <div><div className="text-muted-foreground text-xs">Upstream model</div><span className="font-mono text-xs">{detail.request.finalModelUpstreamId ?? '—'}</span></div>
                <div><div className="text-muted-foreground text-xs">Provider</div>{detail.request.providerId ? <Link className="text-primary underline" to={`/providers?providerId=${encodeURIComponent(detail.request.providerId)}`}>{detail.request.providerName ?? detail.request.providerSlug ?? detail.request.providerId}</Link> : '—'}</div>
                <div><div className="text-muted-foreground text-xs">Route</div>{detail.request.resolvedTargetId ? <Link className="text-primary underline" to={detail.request.resolvedTargetKind === 'combo' ? '/combos' : '/models'}>{detail.request.resolvedTargetKind ?? 'target'}</Link> : '—'}</div>
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
                {detail.request.fallbackReasons.length > 0 && <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2"><div className="text-xs text-muted-foreground">Fallback reasons</div><div className="text-xs">{detail.request.fallbackReasons.join(', ')}</div></div>}
              </TabsContent>
              <TabsContent value="attempts" className="min-w-0 overflow-x-auto">
                {detail.attempts.length > 0 ? (
                  <Table>
                    <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Provider</TableHead><TableHead>Model</TableHead><TableHead>Status</TableHead><TableHead>Latency</TableHead><TableHead>Selection</TableHead><TableHead>Failure</TableHead></TableRow></TableHeader>
                    <TableBody>{detail.attempts.map((a) => (
                      <TableRow key={a.id as string}>
                        <TableCell>{a.attemptNumber as number}</TableCell>
                        <TableCell>{a.providerName as string}</TableCell>
                        <TableCell><div className="font-mono text-xs">{a.modelPublicId as string}</div><div className="text-[11px] text-muted-foreground">upstream: {a.upstreamModelId as string}</div></TableCell>
                        <TableCell>{a.success ? <Badge variant="success">{String(a.statusCode ?? 'OK')}</Badge> : <Badge variant="destructive">{String(a.statusCode ?? 'err')}</Badge>}</TableCell>
                        <TableCell className="text-xs">{formatLatencyMs(a.latencyMs as number)}</TableCell>
                        <TableCell className="text-xs">{a.selectionReason as string}</TableCell>
                        <TableCell className="min-w-[220px] max-w-[320px] text-xs">
                          {a.failureReason ? <div className="font-medium text-destructive">{a.failureReason as string}</div> : <span className="text-muted-foreground">—</span>}
                          {a.sanitizedError ? <div className="mt-1 break-all text-muted-foreground">{a.sanitizedError as string}</div> : null}
                          {a.upstreamRequestId ? <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">upstream request: {a.upstreamRequestId as string}</div> : null}
                        </TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                ) : <div className="text-sm text-muted-foreground">No upstream attempts.</div>}
              </TabsContent>
              <TabsContent value="request" className="min-w-0">
                {detail.request.requestPayload ? (() => { const preview = payloadPreview(detail.request.requestPayload); return <PayloadBlock label="Request content" value={detail.request.requestPayload} preview={preview} onCopy={() => copyText(detail.request.requestPayload!, 'Request JSON')} onDownload={() => downloadText(detail.request.requestPayload!, `request-${detail.request.id}.json`)} />; })() : <div className="text-sm text-muted-foreground">Request content was not retained.</div>}
              </TabsContent>
              <TabsContent value="response" className="min-w-0">
                {detail.request.responsePayload ? (() => { const preview = payloadPreview(detail.request.responsePayload); return <PayloadBlock label="Response content" value={detail.request.responsePayload} preview={preview} onCopy={() => copyText(detail.request.responsePayload!, 'Response JSON')} onDownload={() => downloadText(detail.request.responsePayload!, `response-${detail.request.id}.json`)} />; })() : <div className="text-sm text-muted-foreground">Response content was not retained.</div>}
              </TabsContent>
              <TabsContent value="replay" className="min-w-0">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground"><span>Safe replay curl</span><Button size="sm" variant="ghost" onClick={() => copyText(detail.request.reproductionCurl, 'Curl')}><Copy className="mr-1 h-3.5 w-3.5" /> Copy</Button></div>
                <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{detail.request.reproductionCurl}</pre>
                <p className="mt-1 text-xs text-muted-foreground">Replace the placeholder key before running. No stored secret is included.</p>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PayloadBlock({ label, value, preview, onCopy, onDownload }: { label: string; value: string; preview: { text: string; truncated: boolean }; onCopy: () => void; onDownload: () => void }) {
  return <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs text-muted-foreground">{label}{preview.truncated ? ' (preview)' : ''}</div><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={onCopy}><Copy className="mr-1 h-3.5 w-3.5" /> Copy</Button><Button size="sm" variant="ghost" onClick={onDownload}>Download</Button></div></div><pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{preview.text}</pre>{preview.truncated && <Button size="sm" variant="outline" onClick={() => { const block = document.getElementById(`full-${label}`); block?.classList.remove('hidden'); }}>Show full content</Button>}<pre id={`full-${label}`} className="hidden max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{value}</pre></div>;
}
