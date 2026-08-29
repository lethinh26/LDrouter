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
import { Download } from 'lucide-react';

interface ModelRow {
  id: string; providerId: string; providerSlug: string; providerType: string;
  publicModelId: string; upstreamModelId: string; displayName: string;
  enabled: boolean; upstreamAvailable: boolean; capabilities: Record<string, unknown>;
}
interface Provider { id: string; name: string; slug: string; type: string; }
interface Discovered { upstreamId: string; displayName: string; capabilities: Record<string, unknown>; alreadyImported: boolean; existingModelId: string | null; }

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

  const toggle = (id: string, on: boolean) => {
    api.post(`/api/admin/models/${id}/toggle`).then(() => reload()).catch((e) => toast.error((e as Error).message));
    void on;
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
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">{discovered.length} discovered · {selected.size} selected</div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setSelected(new Set(discovered.filter((d) => !d.alreadyImported).map((d) => d.upstreamId)))}>Select All (new)</Button>
                      <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
                    </div>
                  </div>
                  <div className="max-h-80 space-y-1 overflow-auto rounded border p-2">
                    {discovered.map((d) => (
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
                    ))}
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
                    <Button size="sm" variant="outline" onClick={() => toggle(m.id, !m.enabled)}>{m.enabled ? 'Disable' : 'Enable'}</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
