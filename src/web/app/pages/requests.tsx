// Requests page: paginated list with filters + live updates via the SSE stream.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader, Skeleton } from '../../components/ui/skeleton';
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
import { Link, useSearchParams } from 'react-router-dom';
import { Copy, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { subscribeToRequestStream } from '../../lib/request-stream';
import {
  buildRequestApiQuery,
  mergeLiveRequestRows,
  matchesRequestExplorerFilters,
  parseRequestExplorerFilters,
  serializeRequestExplorerFilters,
  sortRequestRows,
  type RequestExplorerFilters,
  type RequestExplorerRow,
} from '../../lib/request-filters';

interface RequestRow extends RequestExplorerRow {
  finalModelPublicId: string | null;
  finalModelUpstreamId?: string | null; resolvedTargetKind?: string; resolvedTargetId?: string | null; providerId?: string | null; providerName?: string | null; providerSlug?: string | null;
  endpoint: string; ttftMs: number | null; inputTokens: number;
  outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  totalTokens: number; attemptsCount: number; errorType: string | null; errorMessage: string | null;
  apiKeyName: string | null; gatewayCacheHit: boolean;
  requestPayload?: string | null;
  responsePayload?: string | null;
}

interface RequestDetail extends RequestRow { reproductionCurl: string; fallbackReasons: string[]; }

const MAX_SEEN_IDS = 2000;

function rememberRequestId(seenIds: Set<string>, id: string): void {
  if (seenIds.has(id)) return;
  seenIds.add(id);
  if (seenIds.size > MAX_SEEN_IDS) {
    const oldestId = seenIds.values().next().value;
    if (oldestId) seenIds.delete(oldestId);
  }
}

export function Requests() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseRequestExplorerFilters(searchParams), [searchParams]);
  const offsetValue = Number(searchParams.get('offset') ?? 0);
  const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0;
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ request: RequestDetail; attempts: Array<Record<string, unknown>> } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [detailTab, setDetailTab] = useState('overview');
  const [newCount, setNewCount] = useState(0); // live rows arrived since last reload/filter change
  const limit = 50;

  // The stream helper advances its replay cursor after each handled event;
  // this mount-time value is only the initial boundary for this page session.
  const sessionStartedAtRef = useRef<number>(Date.now());
  const seenIdsRef = useRef<Set<string>>(new Set());
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const offsetRef = useRef(offset); offsetRef.current = offset;
  const fetchingRef = useRef(false);
  const liveRowsDuringFetchRef = useRef<Map<string, RequestRow>>(new Map());
  const detailRequestSeqRef = useRef(0);
  const apiQuery = buildRequestApiQuery(filters, limit, offset).toString();

  useEffect(() => { setSearchDraft(filters.search); }, [filters.search]);

  const updateExplorer = (patch: Partial<RequestExplorerFilters>, resetOffset = true): void => {
    const nextFilters = { ...filters, ...patch };
    setSearchParams(serializeRequestExplorerFilters(nextFilters, resetOffset ? 0 : offset), { replace: true });
  };

  const applySearch = (): void => updateExplorer({ search: searchDraft.trim() });

  useEffect(() => {
    let active = true;
    const liveRowsDuringFetch = liveRowsDuringFetchRef.current;
    fetchingRef.current = true;
    liveRowsDuringFetch.clear();
    setLoading(true);
    setLoadError(false);
    api.get<{ total: number; requests: RequestRow[] }>(`/api/admin/requests?${apiQuery}`)
      .then((result) => {
        if (!active) return;
        const liveRows = [...liveRowsDuringFetch.values()];
        const merged = offset === 0
          ? mergeLiveRequestRows(result.requests, liveRows, filtersRef.current, limit)
          : { rows: result.requests, addedCount: 0 };
        setRows(merged.rows);
        setTotal(result.total + merged.addedCount);
        setNewCount(offset === 0 ? merged.addedCount : liveRows.length);
        for (const row of result.requests) rememberRequestId(seenIdsRef.current, row.id);
      })
      .catch(() => {
        if (!active) return;
        setRows([]);
        setTotal(0);
        setLoadError(true);
      })
      .finally(() => {
        if (!active) return;
        fetchingRef.current = false;
        liveRowsDuringFetch.clear();
        setLoading(false);
      });
    return () => {
      active = false;
      fetchingRef.current = false;
      liveRowsDuringFetch.clear();
    };
  }, [apiQuery, reloadVersion, offset]);

  // Reset the "new requests" counter whenever the visible window changes.
  useEffect(() => { setNewCount(0); }, [offset, filters]);

  // Live updates: subscribe to the SSE stream (same reconnect pattern as the
  // notification hook). Rows that match the active filters land in the table
  // immediately when viewing page 1; every arrival bumps the counter badge.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeToRequestStream<RequestRow>(sessionStartedAtRef.current, (data) => {
      if (cancelled || !data || typeof data.id !== 'string' || !data.id) return;
      if (seenIdsRef.current.has(data.id)) return; // replay duplicate — ignore
      rememberRequestId(seenIdsRef.current, data.id);
      if (!matchesRequestExplorerFilters(data, filtersRef.current)) return;
      if (fetchingRef.current) {
        liveRowsDuringFetchRef.current.set(data.id, data);
        if (liveRowsDuringFetchRef.current.size > MAX_SEEN_IDS) {
          const oldestId = liveRowsDuringFetchRef.current.keys().next().value;
          if (oldestId) liveRowsDuringFetchRef.current.delete(oldestId);
        }
      }
      setNewCount((n) => n + 1);
      if (offsetRef.current === 0) {
        setRows((prev) => {
          if (prev.some((r) => r.id === data.id)) return prev;
          return [data, ...prev].slice(0, limit);
        });
        setTotal((t) => t + 1);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const open = async (id: string): Promise<void> => {
    const sequence = ++detailRequestSeqRef.current;
    setOpenId(id);
    setDetailTab('overview');
    setDetail(null);
    setDetailError(false);
    setDetailLoading(true);
    try {
      const result = await api.get<{ request: RequestDetail; attempts: Array<Record<string, unknown>> }>(`/api/admin/requests/${id}`);
      if (detailRequestSeqRef.current === sequence) setDetail(result);
    } catch {
      if (detailRequestSeqRef.current === sequence) setDetailError(true);
    } finally {
      if (detailRequestSeqRef.current === sequence) setDetailLoading(false);
    }
  };

  const copyText = (value: string, label: string) => {
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard access is unavailable in this browser');
      return;
    }
    void navigator.clipboard.writeText(value).then(() => toast.success(`${label} copied`)).catch(() => toast.error(`Could not copy ${label.toLowerCase()}`));
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

  const visibleRows = useMemo(() => sortRequestRows(rows, filters.sort), [rows, filters.sort]);
  const hasFilterCriteria = Boolean(filters.search.trim()) || filters.status !== 'all' || filters.protocol !== 'all' || filters.streaming !== 'all';
  const hasActiveFilters = hasFilterCriteria || filters.sort !== 'newest';
  const refresh = (): void => {
    setNewCount(0);
    setReloadVersion((version) => version + 1);
  };
  const showNewRequests = (): void => {
    setNewCount(0);
    if (offset !== 0) setSearchParams(serializeRequestExplorerFilters(filters, 0), { replace: true });
    else setReloadVersion((version) => version + 1);
  };

  return (
    <div>
      <PageHeader title="Requests" description={`${total} matching · live updates`} />
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><CardTitle className="text-base">Results</CardTitle><p className="mt-1 text-xs text-muted-foreground">{total.toLocaleString()} matching requests</p></div>
            <div className="flex flex-wrap items-center gap-2">
              {newCount > 0 && <Button size="sm" variant="secondary" onClick={showNewRequests}>{newCount} new request{newCount > 1 ? 's' : ''} · refresh</Button>}
              <Button size="sm" variant="outline" onClick={refresh} disabled={loading}><RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} /> Refresh</Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            <div className="flex min-w-0 gap-2 sm:col-span-2">
              <Select value={filters.searchBy} onValueChange={(value) => { setSearchDraft(''); updateExplorer({ searchBy: value as RequestExplorerFilters['searchBy'], search: '' }); }}>
                <SelectTrigger aria-label="Search field" className="w-32 shrink-0"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="model">Model</SelectItem><SelectItem value="id">Request ID</SelectItem><SelectItem value="ip">Client IP</SelectItem></SelectContent>
              </Select>
              <div className="flex min-w-0 flex-1 gap-2">
                <Input aria-label="Search requests" className="min-w-0" placeholder={filters.searchBy === 'id' ? 'Exact request ID…' : filters.searchBy === 'ip' ? 'Exact client IP…' : 'Model contains…'} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applySearch(); }} />
                <Button size="icon" aria-label="Apply search" onClick={applySearch}><Search className="h-4 w-4" /></Button>
              </div>
            </div>
            <Select value={filters.status} onValueChange={(value) => updateExplorer({ status: value as RequestExplorerFilters['status'] })}>
              <SelectTrigger aria-label="Request status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="success">Success</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="4xx">HTTP 4xx</SelectItem><SelectItem value="5xx">HTTP 5xx</SelectItem></SelectContent>
            </Select>
            <Select value={filters.protocol} onValueChange={(value) => updateExplorer({ protocol: value as RequestExplorerFilters['protocol'] })}>
              <SelectTrigger aria-label="Protocol"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any protocol</SelectItem><SelectItem value="openai">OpenAI</SelectItem><SelectItem value="anthropic">Anthropic</SelectItem></SelectContent>
            </Select>
            <Select value={filters.streaming} onValueChange={(value) => updateExplorer({ streaming: value as RequestExplorerFilters['streaming'] })}>
              <SelectTrigger aria-label="Streaming mode"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any mode</SelectItem><SelectItem value="true">Streaming</SelectItem><SelectItem value="false">Non-stream</SelectItem></SelectContent>
            </Select>
            <Select value={filters.sort} onValueChange={(value) => updateExplorer({ sort: value as RequestExplorerFilters['sort'] }, false)}>
              <SelectTrigger aria-label="Sort current page"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="newest">Newest first</SelectItem><SelectItem value="oldest">Oldest first</SelectItem><SelectItem value="latency-desc">Highest latency</SelectItem><SelectItem value="latency-asc">Lowest latency</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {hasActiveFilters ? <Button size="sm" variant="ghost" className="h-8 px-2 text-muted-foreground" onClick={() => { setSearchDraft(''); updateExplorer({ searchBy: 'model', search: '', status: 'all', protocol: 'all', streaming: 'all', sort: 'newest' }); }}><X className="mr-1 h-3.5 w-3.5" /> Clear filters</Button> : <span />}
            <p className="text-xs text-muted-foreground">Sort applies to this page; server pagination stays newest-first.</p>
          </div>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="text-sm font-medium">Could not load request history</p><p className="mt-1 text-sm text-muted-foreground">Check your connection and try again. Your filters have been kept.</p></div>
              <Button size="sm" onClick={refresh}><RefreshCw className="mr-2 h-4 w-4" /> Retry</Button>
            </div>
          ) : (
            <>
              {loading && <p role="status" aria-live="polite" className="sr-only">Loading requests…</p>}
              <div className="overflow-x-auto" aria-busy={loading}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead><TableHead>Status</TableHead><TableHead>Requested</TableHead>
                      <TableHead>Final</TableHead><TableHead>Tokens</TableHead><TableHead>Latency</TableHead>
                      <TableHead>Attempts</TableHead><TableHead>Key</TableHead><TableHead>IP</TableHead><TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading && Array.from({ length: 6 }, (_, index) => <TableRow key={`loading-${index}`}>{Array.from({ length: 10 }, (_, cell) => <TableCell key={cell}><Skeleton className="h-4 w-16" /></TableCell>)}</TableRow>)}
                    {!loading && visibleRows.length === 0 && <TableRow><TableCell colSpan={10} className="py-10 text-center"><p className="text-sm font-medium">{hasFilterCriteria ? 'No requests match these filters' : 'No requests yet'}</p><p className="mt-1 text-xs text-muted-foreground">{hasFilterCriteria ? 'Try changing the search or clearing some filters.' : 'Requests will appear here when your applications start using the gateway.'}</p>{hasActiveFilters && <Button size="sm" variant="outline" className="mt-3" onClick={() => { setSearchDraft(''); updateExplorer({ searchBy: 'model', search: '', status: 'all', protocol: 'all', streaming: 'all', sort: 'newest' }); }}>Clear filters</Button>}</TableCell></TableRow>}
                    {!loading && visibleRows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</TableCell>
                        <TableCell>{r.success ? <Badge variant="success">{r.httpStatus}</Badge> : <Badge variant="destructive">{r.httpStatus}</Badge>}</TableCell>
                        <TableCell className="font-mono text-xs">{r.requestedModel}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.finalModelPublicId ?? '—'}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{formatNumber(r.inputTokens + r.outputTokens)} {r.cacheReadTokens ? <span className="text-amber-600">(+{r.cacheReadTokens} cache)</span> : null}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{formatLatencyMs(r.totalLatencyMs)}{r.ttftMs ? <span className="text-muted-foreground"> · ttft {r.ttftMs}ms</span> : null}</TableCell>
                        <TableCell className="text-xs">{r.attemptsCount}{r.gatewayCacheHit ? <Badge variant="secondary" className="ml-1">cache</Badge> : null}</TableCell>
                        <TableCell className="text-xs">{r.apiKeyName ?? '—'}</TableCell>
                        <TableCell className="text-xs">{r.clientIp}</TableCell>
                        <TableCell className="text-right"><Button size="sm" variant="ghost" aria-label={`View request ${shortId(r.id, 12)}`} onClick={() => void open(r.id)}>View</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Showing {total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={loading || offset === 0} onClick={() => setSearchParams(serializeRequestExplorerFilters(filters, Math.max(0, offset - limit)), { replace: true })}>Prev</Button>
              <Button size="sm" variant="outline" disabled={loading || offset + limit >= total} onClick={() => setSearchParams(serializeRequestExplorerFilters(filters, offset + limit), { replace: true })}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!openId} onOpenChange={(o) => { if (!o) { detailRequestSeqRef.current += 1; setOpenId(null); setDetail(null); setDetailError(false); setDetailLoading(false); } }}>
        <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
          <DialogHeader><DialogTitle>Request {shortId(openId, 16)}</DialogTitle></DialogHeader>
          {detailLoading ? <><p role="status" aria-live="polite" className="sr-only">Loading request details…</p><div aria-busy="true" className="space-y-3 py-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div></> : detailError ? (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"><p className="text-sm font-medium">Could not load request details</p><p className="mt-1 text-sm text-muted-foreground">The request may have expired from retained history, or the connection may have failed.</p><Button size="sm" className="mt-3" onClick={() => { if (openId) void open(openId); }}>Retry</Button></div>
          ) : detail ? (
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
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PayloadBlock({ label, value, preview, onCopy, onDownload }: { label: string; value: string; preview: { text: string; truncated: boolean }; onCopy: () => void; onDownload: () => void }) {
  return <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs text-muted-foreground">{label}{preview.truncated ? ' (preview)' : ''}</div><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={onCopy}><Copy className="mr-1 h-3.5 w-3.5" /> Copy</Button><Button size="sm" variant="ghost" onClick={onDownload}>Download</Button></div></div><pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{preview.text}</pre>{preview.truncated && <Button size="sm" variant="outline" onClick={() => { const block = document.getElementById(`full-${label}`); block?.classList.remove('hidden'); }}>Show full content</Button>}<pre id={`full-${label}`} className="hidden max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{value}</pre></div>;
}
