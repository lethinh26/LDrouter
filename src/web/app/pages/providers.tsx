// Providers page — list + create form.
import { useEffect, useState } from 'react';
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
import { Play, Trash2 } from 'lucide-react';
import { BuiltinProviders } from './builtin-providers';

interface Provider {
  id: string; name: string; slug: string; type: 'openai' | 'anthropic'; baseUrl: string;
  providerKind: 'compatible' | 'codex' | 'claude_code'; authMode: 'api_key' | 'client_oauth';
  enabled: boolean; health: string; modelCount: number;
}

const EMPTY = { name: '', slug: '', type: 'openai' as 'openai' | 'anthropic', baseUrl: 'https://api.openai.com', apiKey: '', customHeaders: '', enabled: true };
const DEFAULT_BASE_URL: Record<'openai' | 'anthropic', string> = {
  openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com',
};
export function Providers() {
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [builtinRevision, setBuiltinRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const editingProvider = rows.find((row) => row.id === editingId);
  const slugLocked = (editingProvider?.modelCount ?? 0) > 0;

  const reload = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.get<{ providers: Provider[] }>('/api/admin/providers');
      setRows(result.providers.filter((p) => p.providerKind === 'compatible'));
    } catch (e) {
      setLoadError((e as Error).message || 'Unable to load custom providers');
    } finally { setLoading(false); }
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
      await api.post('/api/admin/providers', { name: form.name.trim(), slug: form.slug || undefined, type: form.type, providerKind: 'compatible', baseUrl: form.baseUrl, apiKey: form.apiKey, customHeaders, enabled: form.enabled });
      toast.success('Provider created');
      setOpen(false);
      setForm(EMPTY);
      setBuiltinRevision((revision) => revision + 1);
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const r = await api.post<{ ok: boolean; detail: string }>(`/api/admin/providers/${id}/test`);
      if (r.ok) toast.success(`Connection OK: ${r.detail}`);
      else toast.error(`Failed: ${r.detail}`);
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
      await api.patch('/api/admin/providers', { id: editingId, name: editForm.name.trim(), slug: editForm.slug || undefined, type: editForm.type, providerKind: 'compatible', baseUrl: editForm.baseUrl, apiKey: editForm.apiKey || undefined, customHeaders, enabled: editForm.enabled });
      toast.success('Provider updated');
      setEditingId(null);
      setEditForm(EMPTY);
      setBuiltinRevision((revision) => revision + 1);
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };

  const del = async (id: string) => {
    setDeleteSubmitting(true);
    try { await api.del(`/api/admin/providers/${id}`); toast.success('Provider removed'); setBuiltinRevision((revision) => revision + 1); void reload(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setDeleteSubmitting(false); setDeletingId(null); }
  };

  return (
    <div>
      <PageHeader title="Providers" description="Manage built-in integrations and custom upstream endpoints." />
      <BuiltinProviders revision={builtinRevision} />
      <section aria-label="Custom Providers" className="mt-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-xl font-semibold tracking-tight">Custom Providers</h2><p className="text-sm text-muted-foreground">Connect an OpenAI-compatible or Anthropic-compatible endpoint.</p></div>
        <div className="flex gap-2">
          <Dialog open={open} onOpenChange={(next) => { if (!submitting) { setOpen(next); if (!next) setForm(EMPTY); } }}>
            <DialogTrigger asChild><Button disabled={loading || !!loadError}>Add provider</Button></DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New custom provider</DialogTitle>
                <DialogDescription>Configure a compatible API endpoint and its API key.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div><Label htmlFor="provider-name">Name</Label><Input id="provider-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div><Label htmlFor="provider-slug">Slug (optional)</Label><Input id="provider-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /><p className="mt-1 text-xs text-muted-foreground">Unique model prefix. Defaults to the normalized name. Reserved prefixes: combo, cx, cc and builtin-connection-. The slug is locked after models are imported.</p></div>
                <div><Label>Type</Label>
                  <Select value={form.type} onValueChange={(v) => setForm((current) => {
                    const type = v === 'anthropic' ? 'anthropic' : 'openai';
                    return { ...current, type, baseUrl: DEFAULT_BASE_URL[type], apiKey: '', customHeaders: '' };
                  })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI-compatible</SelectItem>
                      <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><Label htmlFor="provider-base-url">Base URL</Label><Input id="provider-base-url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></div>
                <div><Label htmlFor="provider-api-key">API key</Label><Input id="provider-api-key" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>
                <div><Label htmlFor="provider-headers">Custom headers (JSON)</Label><Input id="provider-headers" value={form.customHeaders} onChange={(e) => setForm({ ...form, customHeaders: e.target.value })} placeholder='{"X-Org":"acme"}' /></div>
                <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><Label>Enabled</Label></div>
              </div>
              <DialogFooter>
                <Button variant="outline" disabled={submitting} onClick={() => { setOpen(false); setForm(EMPTY); }}>Cancel</Button>
                <Button disabled={submitting || !form.name.trim() || !form.apiKey} onClick={submit}>{submitting ? 'Creating…' : 'Create'}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Custom connections</CardTitle><CardDescription>{loading ? 'Loading…' : loadError ? 'Unable to load' : `${rows.length} total`}</CardDescription></CardHeader>
        <CardContent>
          {loadError ? <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive">{loadError}<Button size="sm" variant="outline" onClick={() => void reload()}>Retry</Button></div> : (
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
              {loading && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Loading custom providers…</TableCell></TableRow>}
              {!loading && rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No custom providers yet.</TableCell></TableRow>}
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name} <span className="text-xs text-muted-foreground">{p.slug}</span></TableCell>
                  <TableCell><Badge variant="outline">{p.type}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.baseUrl}</TableCell>
                  <TableCell>{p.modelCount}</TableCell>
                  <TableCell><Badge variant={p.health === 'healthy' ? 'success' : p.health === 'down' ? 'destructive' : 'secondary'}>{p.health}</Badge></TableCell>
                  <TableCell>{p.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" title="Test connection" aria-label={`Test ${p.name}`} disabled={loading || testingId !== null} onClick={() => test(p.id)}><Play className="h-3 w-3" /></Button>
                      <Button size="sm" variant="outline" disabled={loading} onClick={() => startEdit(p)}>✎</Button>
                      <Button size="sm" variant="outline" disabled={loading} aria-label={`Delete ${p.name}`} onClick={() => setDeletingId(p.id)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>)}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingId} onOpenChange={(open) => { if (!open && !submitting) { setEditingId(null); setEditForm(EMPTY); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit provider</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="edit-provider-name">Name</Label><Input id="edit-provider-name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div><Label htmlFor="edit-provider-slug">Slug</Label><Input id="edit-provider-slug" value={editForm.slug} disabled={slugLocked} onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })} /><p className="mt-1 text-xs text-muted-foreground">{slugLocked ? 'Locked to preserve existing public model IDs and client configurations.' : 'Unique model prefix; may be changed before importing models.'}</p></div>
            <div><Label>Type</Label>
              <Select value={editForm.type} disabled>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                  <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                  </SelectContent>
              </Select>
            </div>
            <div><Label htmlFor="edit-provider-url">Base URL</Label><Input id="edit-provider-url" value={editForm.baseUrl} onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })} /></div>
            <div><Label htmlFor="edit-provider-key">API key (leave empty to keep current)</Label><Input id="edit-provider-key" type="password" autoComplete="off" value={editForm.apiKey} onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })} /></div>
            <div><Label htmlFor="edit-provider-headers">Custom headers (JSON)</Label><Input id="edit-provider-headers" value={editForm.customHeaders} onChange={(e) => setEditForm({ ...editForm, customHeaders: e.target.value })} placeholder='{"X-Org":"acme"}' /></div>
            <div className="flex items-center gap-2"><Switch checked={editForm.enabled} onCheckedChange={(v) => setEditForm({ ...editForm, enabled: v })} /><Label>Enabled</Label></div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => { setEditingId(null); setEditForm(EMPTY); }}>Cancel</Button>
            <Button disabled={submitting || !editForm.name.trim()} onClick={editSubmit}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete provider?</AlertDialogTitle>
            <AlertDialogDescription>This permanently removes the provider, its models, and dependent routing configuration.</AlertDialogDescription>
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
      </section>
    </div>
  );
}
