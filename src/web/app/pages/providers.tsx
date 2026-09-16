// Providers page — list + create form. Codex providers get a collapsible account-pool group
// with quota, auto-start, and model import; the generic Add Provider modal never collects
// Codex credentials (those come from Import accounts).
import { Fragment, useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Download, Play, Plus, Trash2, UserPlus } from 'lucide-react';
import { CodexUsagePanel } from '../../components/codex-usage-panel';
import { QoderAccountsPanel } from '../../components/qoder-accounts-panel';
import { CodexDiscoverDialog } from '../../components/codex-discover-dialog';

interface Provider {
  id: string; name: string; slug: string; type: 'openai' | 'anthropic' | 'codex' | 'qoder'; baseUrl: string;
  enabled: boolean; health: string; modelCount: number;
}

const EMPTY = { name: '', slug: '', type: 'openai' as 'openai' | 'anthropic', baseUrl: 'https://api.openai.com', apiKey: '', customHeaders: '', enabled: true };
const DEFAULT_BASE_URL: Record<'openai' | 'anthropic', string> = {
  openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com',
};
// Account-pool types are created with one click — the server owns name, slug, and base URL.
const POOL_PROVIDERS = [
  { type: 'codex' as const, label: 'Add Codex', hint: 'Codex always talks to https://chatgpt.com — the OAuth backend does not exist on api.openai.com.' },
  { type: 'qoder' as const, label: 'Add Qoder', hint: 'Qoder accounts authenticate with a PAT (pt-…) that you add after the provider exists.' },
];


export function Providers() {
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The edit dialog may open on a pool provider, so it keeps the full type union.
  const [editForm, setEditForm] = useState<Omit<typeof EMPTY, 'type'> & { type: Provider['type'] }>(EMPTY);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [discoverProvider, setDiscoverProvider] = useState<Provider | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [poolSubmitting, setPoolSubmitting] = useState<string | null>(null);

  const reload = async () => {
    try {
      const result = await api.get<{ providers: Provider[] }>('/api/admin/providers');
      setRows(result.providers);
    } catch (e) { toast.error((e as Error).message || 'Unable to load providers'); }
  };
  // reload is intentionally stable for the page lifetime; mutations call it explicitly.
  useEffect(() => { void reload(); }, []);
  const submit = async () => {
    setSubmitting(true);
    try {
      let customHeaders: Record<string, string> | undefined;
      if (form.customHeaders.trim()) {
        try { customHeaders = JSON.parse(form.customHeaders); }
        catch { throw new Error('Custom headers must be valid JSON object'); }
      }
      await api.post('/api/admin/providers', { name: form.name, slug: form.slug || undefined, type: form.type, baseUrl: form.baseUrl, apiKey: form.apiKey, customHeaders, enabled: form.enabled });
      toast.success('Provider created');
      setOpen(false);
      setForm(EMPTY);
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };

  const addPoolProvider = async (type: 'codex' | 'qoder') => {
    setPoolSubmitting(type);
    try {
      await api.post('/api/admin/providers', { type });
      toast.success(`${type === 'codex' ? 'Codex' : 'Qoder'} provider created — add accounts next`);
      const result = await api.get<{ providers: Provider[] }>('/api/admin/providers');
      setRows(result.providers);
      const created = result.providers.find((row) => row.type === type);
      if (created) setExpanded((current) => ({ ...current, [created.id]: true }));
    } catch (e) { toast.error((e as Error).message); }
    finally { setPoolSubmitting(null); }
  };

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const r = await api.post<{ ok: boolean; detail: string }>(`/api/admin/providers/${id}/test`);
      toast.success(r.ok ? `Connection OK: ${r.detail}` : `Failed: ${r.detail}`);
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setTestingId(null); }
  };

  const startEdit = (p: Provider) => {
    setEditingId(p.id);
    setEditForm({ ...EMPTY, name: p.name, slug: p.slug || '', type: p.type, baseUrl: p.baseUrl, apiKey: '', customHeaders: '', enabled: p.enabled });
  };

  const editSubmit = async () => {
    if (!editingId) return;
    setSubmitting(true);
    try {
      let customHeaders: Record<string, string> | undefined;
      if (editForm.customHeaders.trim()) {
        try { customHeaders = JSON.parse(editForm.customHeaders); }
        catch { throw new Error('Custom headers must be valid JSON object'); }
      }
      await api.patch('/api/admin/providers', { id: editingId, name: editForm.name, slug: editForm.slug || undefined, type: editForm.type, baseUrl: editForm.baseUrl, apiKey: editForm.apiKey || undefined, customHeaders, enabled: editForm.enabled });
      toast.success('Provider updated');
      setEditingId(null);
      setEditForm(EMPTY);
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };

  const del = async (id: string) => {
    setDeleteSubmitting(true);
    try { await api.del(`/api/admin/providers/${id}`); toast.success('Provider removed'); void reload(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setDeleteSubmitting(false); setDeletingId(null); }
  };

  return (
    <div>
      <PageHeader title="Providers" description="Upstream LLM providers and their credentials" actions={
        <div className="flex gap-2">
          {POOL_PROVIDERS.map((pool) => {
            const existing = rows.find((row) => row.type === pool.type);
            return (
              <Button key={pool.type} variant="outline" disabled={!!existing || poolSubmitting === pool.type}
                title={existing ? `${existing.name} already exists` : pool.hint}
                onClick={() => void addPoolProvider(pool.type)}>
                <Plus className="mr-1 h-4 w-4" />{existing ? `${pool.label} (added)` : pool.label}
              </Button>
            );
          })}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button>Add compatible provider</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New provider</DialogTitle>
                <DialogDescription>API-key or compatible endpoint.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div><Label htmlFor="provider-name">Name</Label><Input id="provider-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div><Label htmlFor="provider-slug">Slug (optional)</Label><Input id="provider-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></div>
                <div><Label>Type</Label>
                  <Select value={form.type} onValueChange={(v) => setForm((current) => ({ ...current, type: v as 'openai' | 'anthropic', baseUrl: DEFAULT_BASE_URL[v as 'openai' | 'anthropic'] }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI-compatible</SelectItem>
                      <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><Label htmlFor="provider-base-url">Base URL</Label><Input id="provider-base-url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></div>
                <div><Label htmlFor="provider-api-key">API key</Label><Input id="provider-api-key" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>
                <div><Label htmlFor="provider-headers">Custom headers (JSON)</Label><Input id="provider-headers" value={form.customHeaders} onChange={(e) => setForm({ ...form, customHeaders: e.target.value })} placeholder='{"X-Org":"acme"}' /></div>
                <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><Label>Enabled</Label></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button disabled={submitting || !form.name || !form.apiKey} onClick={submit}>{submitting ? 'Creating…' : 'Create'}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      } />
      <Card>
        <CardHeader><CardTitle className="text-base">All providers</CardTitle><CardDescription>{rows.length} total</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No providers yet.</TableCell></TableRow>}
              {rows.map((p) => (
                <Fragment key={p.id}>
                <TableRow>
                  <TableCell className="font-medium">{p.name} <span className="text-xs text-muted-foreground">{p.slug}</span></TableCell>
                  <TableCell><Badge variant="outline">{p.type}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.baseUrl}</TableCell>
                  <TableCell>{p.modelCount}</TableCell>
                  <TableCell><Badge variant={p.health === 'healthy' ? 'success' : p.health === 'down' ? 'destructive' : 'secondary'}>{p.health}</Badge></TableCell>
                  <TableCell>{p.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {(p.type === 'codex' || p.type === 'qoder') && (
                        <>
                          <Button size="sm" variant={expanded[p.id] ? 'secondary' : 'outline'} aria-expanded={!!expanded[p.id]} onClick={() => setExpanded((current) => ({ ...current, [p.id]: !current[p.id] }))}>
                            {expanded[p.id] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            <span className="ml-1">Accounts</span>
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setDiscoverProvider(p)}><Download className="mr-1 h-3 w-3" /> Import models</Button>
                        </>
                      )}
                      <Button size="sm" variant="outline" disabled={testingId === p.id} onClick={() => test(p.id)}><Play className="h-3 w-3" /></Button>
                      <Button size="sm" variant="outline" onClick={() => startEdit(p)}>✎</Button>
                      <Button size="sm" variant="outline" onClick={() => setDeletingId(p.id)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
                {p.type === 'codex' && expanded[p.id] && (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-muted/30">
                      <CodexUsagePanel providerId={p.id} providerName={p.name} />
                    </TableCell>
                  </TableRow>
                )}
                {p.type === 'qoder' && expanded[p.id] && (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-muted/30">
                      <QoderAccountsPanel providerId={p.id} providerName={p.name} />
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {discoverProvider && <CodexDiscoverDialog providerId={discoverProvider.id} providerName={discoverProvider.name} open onOpenChange={(next) => { if (!next) setDiscoverProvider(null); }} onImported={() => void reload()} />}

      {/* Edit Dialog */}
      <Dialog open={!!editingId} onOpenChange={(open) => { if (!open) { setEditingId(null); setEditForm(EMPTY); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit provider</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div><Label>Slug (optional)</Label><Input value={editForm.slug} onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })} /></div>
            <div><Label>Type</Label>
              <Select value={editForm.type} onValueChange={(v) => setEditForm({ ...editForm, type: v as 'openai' | 'anthropic' | 'codex' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                  <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                  <SelectItem value="codex">Codex OAuth</SelectItem>
                  </SelectContent>
              </Select>
            </div>
            {editForm.type === 'codex'
              ? <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"><UserPlus className="mr-1 inline h-3 w-3" /> Codex credentials live in the account pool — manage them from the Accounts panel.</p>
              : <>
                  <div><Label>Base URL</Label><Input value={editForm.baseUrl} onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })} /></div>
                  <div><Label>API key (leave empty to keep current)</Label><Input type="password" value={editForm.apiKey} onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })} /></div>
                </>}
            <div><Label>Custom headers (JSON)</Label><Input value={editForm.customHeaders} onChange={(e) => setEditForm({ ...editForm, customHeaders: e.target.value })} placeholder='{"X-Org":"acme"}' /></div>
            <div className="flex items-center gap-2"><Switch checked={editForm.enabled} onCheckedChange={(v) => setEditForm({ ...editForm, enabled: v })} /><Label>Enabled</Label></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditingId(null); setEditForm(EMPTY); }}>Cancel</Button>
            <Button disabled={submitting || !editForm.name} onClick={editSubmit}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete provider?</AlertDialogTitle>
            <AlertDialogDescription>This will soft-disable the provider if models depend on it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteSubmitting}
              onClick={(e) => {
                if (!deletingId) return;
                e.preventDefault(); // keep the dialog open until the request settles
                void del(deletingId);
              }}
            >
              {deleteSubmitting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
