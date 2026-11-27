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
import { api, fetchWithCsrf } from '../../lib/api';
import { toast } from 'sonner';
import { ChevronDown, Download, Trash2, FlaskConical, Loader2, Search, X, SlidersHorizontal } from 'lucide-react';

// A capability the admin can declare. Anything left off stays "unknown",
// which the router treats as allowed rather than unsupported.
export const TUNABLE_CAPS = ['image_input', 'audio_input', 'tools', 'structured_output', 'reasoning', 'chat', 'streaming'] as const;
export type TunableCap = typeof TUNABLE_CAPS[number];
export const CAP_TRI = ['unknown', 'yes', 'no'] as const;
export type CapTri = typeof CAP_TRI[number];

/** Read a stored tri-state capability: absent = unknown. */
export function capTri(caps: Record<string, unknown>, key: TunableCap): CapTri {
  return caps[key] === true ? 'yes' : caps[key] === false ? 'no' : 'unknown';
}

/**
 * Materialize the tri-state selection as the PATCH payload for one model.
 * "unknown" is sent as null so the server removes the key: serializing it as
 * `undefined` would drop it from the JSON body and leave the old value in place.
 */
export function capsPatch(tri: Record<string, CapTri>): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const k of TUNABLE_CAPS) out[k] = tri[k] === 'yes' ? true : tri[k] === 'no' ? false : null;
  return out;
}

interface ModelRow {
  id: string; providerId: string; providerSlug: string; providerType: string;
  publicModelId: string; upstreamModelId: string; displayName: string;
  enabled: boolean; upstreamAvailable: boolean; capabilities: Record<string, unknown>;
  discoveredCapabilities: Record<string, unknown> | null; maxContextTokens: number | null; maxOutputTokens: number | null;
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

const compareAlphabetically = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function Models() {
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
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
  const [capTarget, setCapTarget] = useState<ModelRow | null>(null);
  const [capTriState, setCapTriState] = useState<Record<string, CapTri>>({});
  const [savingCaps, setSavingCaps] = useState(false);

  const openCaps = (m: ModelRow) => {
    const tri: Record<string, CapTri> = {};
    for (const k of TUNABLE_CAPS) tri[k] = capTri(m.capabilities, k);
    setCapTriState(tri);
    setCapTarget(m);
  };

  const saveCaps = async () => {
    if (!capTarget) return;
    setSavingCaps(true);
    try {
      await api.patch('/api/admin/models', { id: capTarget.id, capabilities: capsPatch(capTriState) });
      toast.success('Capabilities updated');
      setCapTarget(null);
      void reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingCaps(false);
    }
  };

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
    if (search) {
      const query = search.toLowerCase();
      const provider = providers.find((p) => p.id === m.providerId);
      if (![m.publicModelId, m.upstreamModelId, m.displayName, provider?.name, m.providerSlug]
        .some((value) => value?.toLowerCase().includes(query))) return false;
    }
    return true;
  });

  const sortedProviders = [...providers].sort((a, b) => compareAlphabetically(a.name || a.slug, b.name || b.slug));
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const providerGroups = Array.from(filtered.reduce((groups, model) => {
    const provider = providerById.get(model.providerId);
    const id = model.providerId || model.providerSlug;
    const group = groups.get(id) ?? {
      id,
      name: provider?.name || model.providerSlug || 'Unknown provider',
      slug: provider?.slug || model.providerSlug,
      type: provider?.type || model.providerType,
      models: [],
    };
    group.models.push(model);
    groups.set(id, group);
    return groups;
  }, new Map<string, { id: string; name: string; slug: string; type: string; models: ModelRow[] }>()).values())
    .map((group) => ({
      ...group,
      models: group.models.sort((a, b) => compareAlphabetically(a.displayName || a.upstreamModelId, b.displayName || b.upstreamModelId)
        || compareAlphabetically(a.upstreamModelId, b.upstreamModelId)),
    }))
    .sort((a, b) => compareAlphabetically(a.name, b.name));

  const toggleProvider = (providerId: string) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

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
      // NB: `fetch` is shadowed by the local "Fetch models" helper, so go through the CSRF-aware
      // wrapper from lib/api instead of the bare global (which would be rejected 403).
      const res = await fetchWithCsrf(`/api/admin/models/${id}/test-stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
          <CardDescription>{filtered.length} of {rows.length} models across {providerGroups.length} providers · alphabetically sorted</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Select value={providerFilter} onValueChange={setProviderFilter}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All providers</SelectItem>
                {sortedProviders.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9 pr-9" placeholder="Search model name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <Button type="button" size="icon" variant="ghost" className="absolute right-1 top-0.5 h-8 w-8" onClick={() => setSearch('')} aria-label="Clear model search"><X className="h-4 w-4" /></Button>}
            </div>
            {!search && providerGroups.length > 0 && <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setExpandedProviders(new Set(providerGroups.map((group) => group.id)))}>Expand all</Button>
              <Button size="sm" variant="ghost" onClick={() => setExpandedProviders(new Set())}>Collapse all</Button>
            </div>}
          </div>
          <div className="space-y-3">
            {providerGroups.length === 0 && <div className="rounded-lg border border-dashed px-4 py-10 text-center">
              <p className="font-medium">No models found</p>
              <p className="mt-1 text-sm text-muted-foreground">Try another search or provider filter, or fetch models from a provider.</p>
            </div>}
            {providerGroups.map((group) => {
              const expanded = search.trim().length > 0 || expandedProviders.has(group.id);
              const availableCount = group.models.filter((model) => model.upstreamAvailable).length;
              const enabledCount = group.models.filter((model) => model.enabled).length;
              const contentId = `provider-models-${group.id}`;
              return <Card key={group.id} className="overflow-hidden shadow-none">
                <CardHeader className="p-0">
                  <Button type="button" variant="ghost" aria-expanded={expanded} aria-controls={contentId} onClick={() => toggleProvider(group.id)} className="h-auto w-full justify-between rounded-none px-4 py-3 text-left hover:bg-muted/50">
                    <span className="flex min-w-0 items-center gap-3">
                      <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-semibold text-foreground">{group.name}</span>
                          <Badge variant="outline">{group.type}</Badge>
                        </span>
                        <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">{group.slug}</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{group.models.length} models</Badge>
                      <Badge variant={availableCount > 0 ? 'success' : 'destructive'}>{availableCount} available</Badge>
                      <span className="hidden text-xs text-muted-foreground sm:inline">{enabledCount} enabled</span>
                    </span>
                  </Button>
                </CardHeader>
                {expanded && <CardContent id={contentId} className="border-t p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead><TableHead>Public ID</TableHead><TableHead>Capabilities</TableHead>
                        <TableHead>Available</TableHead><TableHead>Enabled</TableHead><TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.models.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="font-medium">{m.displayName || m.upstreamModelId}<div className="mt-0.5 text-xs font-normal text-muted-foreground">{m.upstreamModelId}</div></TableCell>
                          <TableCell className="font-mono text-xs">{m.publicModelId}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(m.capabilities).filter(([, value]) => value === true).slice(0, 4).map(([key]) => <Badge key={key} variant="outline">{key}</Badge>)}
                              {Object.values(m.capabilities).every((value) => value !== true) && <span className="text-xs text-muted-foreground">—</span>}
                            </div>
                          </TableCell>
                          <TableCell>{m.upstreamAvailable ? <Badge variant="success">Available</Badge> : <Badge variant="destructive">Unavailable</Badge>}</TableCell>
                          <TableCell>{m.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="secondary">Disabled</Badge>}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button size="sm" variant="outline" onClick={() => openCaps(m)} disabled={testingId !== null}><SlidersHorizontal className="h-3.5 w-3.5" /> Capabilities</Button>
                              <Button size="sm" variant="outline" onClick={() => void testModel(m.id)} disabled={testingId !== null}>{testingId === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} Test</Button>
                              <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(m)} disabled={testingId !== null}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>}
              </Card>;
            })}
          </div>
        </CardContent>
      </Card>

      {/* Delete confirmation modal */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Xoá model</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p>Bạn có chắc muốn xoá model <span className="font-mono">{deleteTarget?.publicModelId}</span>?</p>
            <p className="text-muted-foreground">Model sẽ bị xoá khỏi combo, alias, permission và cache trước khi xoá hẳn.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Huỷ</Button>
            <Button variant="destructive" onClick={handleDelete}>Xoá</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Capability override dialog */}
      <Dialog open={capTarget !== null} onOpenChange={(o) => { if (!o) setCapTarget(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Capabilities — {capTarget?.publicModelId}</DialogTitle></DialogHeader>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              <strong>Unknown</strong> means the router has no verified answer and will attempt the request.{' '}
              <strong>No</strong> blocks requests needing that capability (HTTP 400/502 before any upstream call).
            </p>
            {TUNABLE_CAPS.map((k) => {
              const discovered = capTarget?.discoveredCapabilities?.[k];
              return (
                <div key={k} className="flex items-center justify-between gap-3 rounded px-1 py-1 text-sm hover:bg-accent">
                  <span className="flex items-baseline gap-2">
                    <code className="text-xs">{k}</code>
                    <span className="text-xs text-muted-foreground">
                      {discovered === undefined ? 'discovered: unknown' : `discovered: ${String(discovered)}`}
                    </span>
                  </span>
                  <div className="flex gap-1">
                    {CAP_TRI.map((t) => (
                      <Button
                        key={t}
                        size="sm"
                        variant={capTriState[k] === t ? 'default' : 'outline'}
                        onClick={() => setCapTriState((prev) => ({ ...prev, [k]: t }))}
                      >
                        {t === 'unknown' ? 'Unknown' : t === 'yes' ? 'Yes' : 'No'}
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCapTarget(null)}>Huỷ</Button>
            <Button onClick={saveCaps} disabled={savingCaps}>{savingCaps ? 'Saving…' : 'Lưu'}</Button>
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
