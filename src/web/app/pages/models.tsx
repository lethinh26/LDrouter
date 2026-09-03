// Models page: list + selective import modal.
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Checkbox } from '../../components/ui/checkbox';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Download, Trash2, FlaskConical, Loader2, Search, X } from 'lucide-react';

interface ModelRow {
  id: string; providerId: string; providerSlug: string; providerType: string;
  publicModelId: string; upstreamModelId: string; displayName: string;
  enabled: boolean; upstreamAvailable: boolean; capabilities: Record<string, unknown>;
}
interface Provider { id: string; name: string; slug: string; type: string; }
interface Discovered { upstreamId: string; displayName: string; capabilities: Record<string, unknown>; alreadyImported: boolean; existingModelId: string | null; }
interface TestResult {
  success: boolean;
  text: string;
  latencyMs: number;
  ttftMs: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
  attempts: Array<{ providerName: string; modelId: string; latencyMs: number; ttftMs: number | null; success: boolean; failureReason: string | null }>;
}
interface TestProgress { ttftMs?: number; elapsedMs?: number; }
type TestState =
  | { phase: 'streaming'; startedAt: number; text: string; progress: TestProgress }
  | { phase: 'error'; model: string; error: string }
  | { phase: 'done'; model: string; result: TestResult; text: string };

export function Models() {
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetchProviderId, setFetchProviderId] = useState<string>('');
  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState(false);
  const [search, setSearch] = useState('');
  const [discoverSearch, setDiscoverSearch] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testResult, setTestResult] = useState<TestState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelRow | null>(null);

  const reload = async () => {
    const [m, p] = await Promise.all([
      api.get<{ models: ModelRow[] }>('/api/admin/models'),
      api.get<{ providers: Provider[] }>('/api/admin/providers'),
    ]);
    setRows(m.models);
    setProviders(p.providers);
  };
  useEffect(() => { void reload(); }, []);

  const filtered = rows.filter((m) => {
    if (providerFilter !== 'all' && m.providerId !== providerFilter) return false;
    if (search && !m.publicModelId.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Discovered models filtered by search
  const filteredDiscovered = discovered.filter((d) => {
    if (!discoverSearch) return true;
    const q = discoverSearch.toLowerCase();
    return d.upstreamId.toLowerCase().includes(q) || d.displayName.toLowerCase().includes(q);
  });

  const fetch = async () => {
    if (!fetchProviderId) return;
    setFetching(true);
    try {
      const r = await api.post<{ models: Discovered[] }>(`/api/admin/providers/${fetchProviderId}/discover`);
      setDiscovered(r.models);
      setSelected(new Set());
    } catch (e) { toast.error((e as Error).message); }
    finally { setFetching(false); }
  };

  const importSelected = async () => {
    if (selected.size === 0) return;
    try {
      const r = await api.post<{ imported: number; requested: number }>('/api/admin/models/import', { providerId: fetchProviderId, modelIds: Array.from(selected) });
      toast.success(`Imported ${r.imported} of ${r.requested}`);
      setFetchOpen(false); setDiscovered([]); setSelected(new Set());
      void reload();
    } catch (e) { toast.error((e as Error).message); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.del(`/api/admin/models/${deleteTarget.id}`);
      toast.success('Model deleted');
      setDeleteTarget(null);
      void reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const testModel = async (id: string) => {
    setTestingId(id);
    setTestOpen(true);
    const startedAt = Date.now();
    setTestResult({ phase: 'streaming', startedAt, text: '', progress: {} });

    try {
      // Fetch SSE stream from the test-stream endpoint.
      // NB: `fetch` is shadowed by the local "Fetch models" helper, so use
      // globalThis.fetch to reach the browser's fetch.
      const res = await globalThis.fetch(`/api/admin/models/${id}/test-stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: '{}', // Must send empty object to satisfy Fastify's JSON parser
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        setTestResult({ phase: 'error', model: id, error: `HTTP ${res.status}: ${errText}` });
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setTestResult({ phase: 'error', model: id, error: 'No response body' }); return; }

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedText = '';
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        if (value) buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = rawEvent.split('\n');
          let event = '';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (!data) continue;

          // SSE from runner: data chunks (OpenAI format)
          if (event === '' || event === 'message') {
            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              if (choice?.delta?.content) {
                accumulatedText += choice.delta.content;
              }
              // Track TTFT from first chunk
              setTestResult((prev) => {
                if (!prev || prev.phase !== 'streaming') return prev;
                const elapsed = Date.now() - startedAt;
                const ttft = prev.progress.ttftMs ?? elapsed;
                return { ...prev, text: accumulatedText, progress: { ttftMs: ttft, elapsedMs: elapsed } };
              });
            } catch { /* ignore parse errors */ }
          }

          // test_meta: final stats
          if (event === 'test_meta') {
            try {
              const meta = JSON.parse(data) as TestResult;
              setTestResult({ phase: 'done', model: id, result: meta, text: accumulatedText });
            } catch { /* ignore */ }
          }

          // test_error
          if (event === 'test_error') {
            try {
              const err = JSON.parse(data) as { message: string };
              setTestResult({ phase: 'error', model: id, error: err.message });
            } catch { /* ignore */ }
          }
        }
      }

      // Stream ended without test_meta — treat as error
      setTestResult((prev) => {
        if (!prev || prev.phase === 'streaming') {
          return { phase: 'error', model: id, error: 'Stream ended unexpectedly' };
        }
        return prev;
      });
    } catch (e) {
      setTestResult({ phase: 'error', model: id, error: (e as Error).message });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div>
      <PageHeader title="Models" description="Physical models imported from providers" actions={
        <Dialog open={fetchOpen} onOpenChange={setFetchOpen}>
          <DialogTrigger asChild>
            <Button variant="outline"><Download className="mr-1 h-4 w-4" /> Fetch models</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Discover models</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Select value={fetchProviderId} onValueChange={setFetchProviderId}>
                    <SelectTrigger><SelectValue placeholder="Choose provider" /></SelectTrigger>
                    <SelectContent>{providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Button onClick={fetch} disabled={!fetchProviderId || fetching}>{fetching ? 'Fetching…' : 'Fetch'}</Button>
              </div>
              {discovered.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1">
                      <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input className="pl-8" placeholder="Search models…" value={discoverSearch} onChange={(e) => setDiscoverSearch(e.target.value)} />
                        {discoverSearch && (
                          <button className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground" onClick={() => setDiscoverSearch('')}><X className="h-4 w-4" /></button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">{filteredDiscovered.length} / {discovered.length} · {selected.size} selected</span>
                      <Button variant="outline" size="sm" onClick={() => setSelected(new Set(filteredDiscovered.filter((d) => !d.alreadyImported).map((d) => d.upstreamId)))}>Select All (new)</Button>
                      <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
                    </div>
                  </div>
                  <div className="max-h-80 space-y-1 overflow-auto rounded border p-2">
                    {filteredDiscovered.length === 0 && discovered.length > 0 ? (
                      <div className="text-center text-sm text-muted-foreground py-4">No models match your search.</div>
                    ) : (
                      filteredDiscovered.map((d) => (
                        <label key={d.upstreamId} className="flex items-center gap-2 rounded p-1 text-sm hover:bg-accent">
                          <Checkbox
                            checked={selected.has(d.upstreamId)}
                            onCheckedChange={(c) => {
                              const next = new Set(selected);
                              if (c) next.add(d.upstreamId); else next.delete(d.upstreamId);
                              setSelected(next);
                            }}
                          />
                          <span className="font-mono text-xs">{d.upstreamId}</span>
                          {d.alreadyImported && <Badge variant="secondary">imported</Badge>}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFetchOpen(false)}>Cancel</Button>
              <Button disabled={selected.size === 0} onClick={importSelected}>Import {selected.size || ''}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      } />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All models</CardTitle>
          <CardDescription>{rows.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center gap-2">
            <Select value={providerFilter} onValueChange={setProviderFilter}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All providers</SelectItem>
                {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input className="max-w-xs" placeholder="Search public ID" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Public ID</TableHead><TableHead>Provider</TableHead><TableHead>Upstream ID</TableHead>
                <TableHead>Capabilities</TableHead><TableHead>Available</TableHead><TableHead>Enabled</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No models</TableCell></TableRow>}
              {filtered.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-xs">{m.publicModelId}</TableCell>
                  <TableCell>{m.providerSlug}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{m.upstreamModelId}</TableCell>
                  <TableCell className="space-x-1">
                    {Object.entries(m.capabilities).filter(([, v]) => v === true).slice(0, 4).map(([k]) => (
                      <Badge key={k} variant="outline" className="mr-1">{k}</Badge>
                    ))}
                  </TableCell>
                  <TableCell>{m.upstreamAvailable ? <Badge variant="success">up</Badge> : <Badge variant="destructive">down</Badge>}</TableCell>
                  <TableCell>{m.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => void testModel(m.id)} disabled={testingId !== null}>
                        {testingId === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} Test
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(m)} disabled={testingId !== null}>
                        <Trash2 className="h-3.5 w-3.5" /> Xoá
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Delete confirmation modal */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Xoá model</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p>Bạn có chắc muốn xoá model <span className="font-mono">{deleteTarget?.publicModelId}</span>?</p>
            <p className="text-muted-foreground">Model đang được dùng trong combo sẽ bị soft-disable (vô hiệu hoá) thay vì xoá hẳn, để giữ lịch sử và tham chiếu combo.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Huỷ</Button>
            <Button variant="destructive" onClick={handleDelete}>Xoá</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test result modal */}
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Kết quả test model</DialogTitle></DialogHeader>

          {/* Streaming in progress */}
          {testResult && testResult.phase === 'streaming' && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Đang stream…
                <span className="font-mono text-xs text-muted-foreground/60">TTFT {testResult.progress.ttftMs != null ? `${testResult.progress.ttftMs} ms` : '…'}</span>
                <span className="font-mono text-xs text-muted-foreground/60">· {testResult.progress.elapsedMs != null ? `${testResult.progress.elapsedMs} ms` : '…'}</span>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Phản hồi (streaming)</div>
                <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-muted p-3 font-mono text-xs">{testResult.text || <span className="text-muted-foreground/60 animate-pulse">waiting for first token…</span>}{testResult.phase === 'streaming' && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary/70" />}</div>
              </div>
            </div>
          )}

          {/* Completed result */}
          {testResult && testResult.phase === 'done' && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={testResult.result.success ? 'success' : 'destructive'}>{testResult.result.success ? 'Thành công' : 'Thất bại'}</Badge>
                <div>
                  <div className="text-xs text-muted-foreground">Thời gian phản hồi</div>
                  <div className="font-mono">{testResult.result.latencyMs} ms</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">TTFT</div>
                  <div className="font-mono">{testResult.result.ttftMs != null ? `${testResult.result.ttftMs} ms` : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Tokens (in / out)</div>
                  <div className="font-mono">{testResult.result.usage.input} / {testResult.result.usage.output}</div>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Phản hồi của model</div>
                <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-muted p-3 font-mono text-xs">{testResult.text || testResult.result.text || '(trống)'}</div>
              </div>
              {testResult.result.attempts.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Attempts</div>
                  <div className="space-y-1">
                    {testResult.result.attempts.map((a, i) => (
                      <div key={i} className="flex items-center gap-2 rounded border p-2 text-xs">
                        <Badge variant={a.success ? 'success' : 'destructive'}>{a.success ? 'OK' : 'FAIL'}</Badge>
                        <span className="font-mono">{a.providerName} / {a.modelId}</span>
                        <span className="text-muted-foreground">{a.latencyMs} ms</span>
                        {a.failureReason && <span className="text-destructive">{a.failureReason}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Error state */}
          {testResult && testResult.phase === 'error' && (
            <div className="space-y-2 text-sm">
              <Badge variant="destructive">Thất bại</Badge>
              <p className="text-destructive">{testResult.error}</p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)}>Đóng</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
