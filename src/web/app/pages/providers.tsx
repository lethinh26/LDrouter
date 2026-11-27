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

interface Provider {
  id: string; name: string; slug: string; type: 'openai' | 'anthropic'; baseUrl: string;
  providerKind: 'compatible' | 'codex' | 'claude_code'; authMode: 'api_key' | 'client_oauth';
  enabled: boolean; health: string; modelCount: number;
}

const EMPTY = { name: '', slug: '', type: 'openai' as 'openai' | 'anthropic', providerKind: 'compatible' as Provider['providerKind'], baseUrl: 'https://api.openai.com', apiKey: '', customHeaders: '', enabled: true };
const DEFAULT_BASE_URL: Record<'openai' | 'anthropic', string> = {
  openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com',
};
function integrationHelp(kind: Provider['providerKind'], slug: string) {
  if (kind === 'codex') return `model_provider = "latedev-codex"\nmodel = "${slug || 'codex'}/YOUR_IMPORTED_MODEL"\n\n[model_providers.latedev-codex]\nname = "LateDev Codex"\nbase_url = "${window.location.origin}/backend-api/codex"\nmodel_catalog_url = "${window.location.origin}/backend-api/codex/models"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nenv_http_headers = { "X-API-Key" = "LATEDEV_API_KEY" }`;
  return `ANTHROPIC_BASE_URL=${window.location.origin}\nANTHROPIC_AUTH_TOKEN=YOUR_GATEWAY_API_KEY\nANTHROPIC_MODEL=${slug || 'claude-code'}/YOUR_IMPORTED_MODEL`;
}
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
  const editingProvider = rows.find((row) => row.id === editingId);
  const slugLocked = (editingProvider?.modelCount ?? 0) > 0;

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
      await api.post('/api/admin/providers', { name: form.name, slug: form.slug || undefined, type: form.type, providerKind: form.providerKind, baseUrl: form.baseUrl, apiKey: form.providerKind === 'codex' ? undefined : form.apiKey, customHeaders: form.providerKind === 'codex' ? undefined : customHeaders, enabled: form.enabled });
      toast.success('Provider created');
      setOpen(false);
      setForm(EMPTY);
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
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
    setEditForm({ ...EMPTY, name: p.name, slug: p.slug || '', type: p.type, providerKind: p.providerKind, baseUrl: p.baseUrl, apiKey: '', customHeaders: '', enabled: p.enabled });
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
      await api.patch('/api/admin/providers', { id: editingId, name: editForm.name, slug: editForm.slug || undefined, type: editForm.type, providerKind: editForm.providerKind, baseUrl: editForm.baseUrl, apiKey: editForm.providerKind === 'codex' ? undefined : editForm.apiKey || undefined, customHeaders: editForm.providerKind === 'codex' ? undefined : customHeaders, enabled: editForm.enabled });
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
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button>Add provider</Button></DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New provider</DialogTitle>
                <DialogDescription>Choose an upstream integration and credential mode.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div><Label htmlFor="provider-name">Name</Label><Input id="provider-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div><Label htmlFor="provider-slug">Slug (optional)</Label><Input id="provider-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /><p className="mt-1 text-xs text-muted-foreground">Unique model prefix. Defaults to the normalized name. Reserved prefix: combo. The slug is locked after models are imported.</p></div>
                <div><Label>Type</Label>
                  <Select value={form.providerKind === 'compatible' ? form.type : form.providerKind} onValueChange={(v) => setForm((current) => {
                    const type = v === 'anthropic' || v === 'claude_code' ? 'anthropic' : 'openai';
                    return { ...current, type, providerKind: v === 'codex' || v === 'claude_code' ? v : 'compatible', baseUrl: v === 'codex' ? 'https://chatgpt.com' : DEFAULT_BASE_URL[type], apiKey: '', customHeaders: '' };
                  })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI-compatible</SelectItem>
                      <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                      <SelectItem value="codex">Codex (client sign-in)</SelectItem>
                      <SelectItem value="claude_code">Claude Code (API key)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><Label htmlFor="provider-base-url">Base URL</Label><Input id="provider-base-url" disabled={form.providerKind !== 'compatible'} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></div>
                {form.providerKind !== 'codex' && <div><Label htmlFor="provider-api-key">API key</Label><Input id="provider-api-key" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>}
                {form.providerKind === 'compatible' && <div><Label htmlFor="provider-headers">Custom headers (JSON)</Label><Input id="provider-headers" value={form.customHeaders} onChange={(e) => setForm({ ...form, customHeaders: e.target.value })} placeholder='{"X-Org":"acme"}' /></div>}
                {form.providerKind === 'codex' && <p className="rounded-md border p-3 text-sm text-muted-foreground">Sign in inside Codex. LateDev never stores your ChatGPT token. Import model IDs manually, then connect with a separate scoped gateway key without token caps. Codex native combos support distinct Codex models accessible to the same signed-in account; standard combos cannot include Codex models.</p>}
                {form.providerKind === 'claude_code' && <p className="rounded-md border p-3 text-sm text-muted-foreground">Use your own Anthropic API key. Claude subscription OAuth tokens are not supported.</p>}
                <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><Label>Enabled</Label></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button disabled={submitting || !form.name || (form.providerKind !== 'codex' && !form.apiKey)} onClick={submit}>{submitting ? 'Creating…' : 'Create'}</Button>
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
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name} <span className="text-xs text-muted-foreground">{p.slug}</span></TableCell>
                  <TableCell><Badge variant="outline">{p.providerKind === 'codex' ? 'Codex OAuth' : p.providerKind === 'claude_code' ? 'Claude Code' : p.type}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.baseUrl}</TableCell>
                  <TableCell>{p.modelCount}</TableCell>
                  <TableCell><Badge variant={p.health === 'healthy' ? 'success' : p.health === 'down' ? 'destructive' : 'secondary'}>{p.health}</Badge></TableCell>
                  <TableCell>{p.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" title={p.providerKind === 'codex' ? 'Test from signed-in Codex client' : 'Test connection'} disabled={testingId === p.id || p.providerKind === 'codex'} onClick={() => test(p.id)}><Play className="h-3 w-3" /></Button>
                      <Button size="sm" variant="outline" onClick={() => startEdit(p)}>✎</Button>
                      <Button size="sm" variant="outline" onClick={() => setDeletingId(p.id)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingId} onOpenChange={(open) => { if (!open) { setEditingId(null); setEditForm(EMPTY); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit provider</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div><Label htmlFor="edit-provider-slug">Slug</Label><Input id="edit-provider-slug" value={editForm.slug} disabled={slugLocked} onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })} /><p className="mt-1 text-xs text-muted-foreground">{slugLocked ? 'Locked to preserve existing public model IDs and client configurations.' : 'Unique model prefix; may be changed before importing models.'}</p></div>
            <div><Label>Type</Label>
              <Select value={editForm.providerKind === 'compatible' ? editForm.type : editForm.providerKind} disabled>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                  <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                  <SelectItem value="codex">Codex (client sign-in)</SelectItem>
                  <SelectItem value="claude_code">Claude Code (API key)</SelectItem>
                  </SelectContent>
              </Select>
            </div>
            <div><Label>Base URL</Label><Input disabled={editForm.providerKind !== 'compatible'} value={editForm.baseUrl} onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })} /></div>
            {editForm.providerKind !== 'codex' && <div><Label>API key (leave empty to keep current)</Label><Input type="password" value={editForm.apiKey} onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })} /></div>}
            {editForm.providerKind === 'compatible' && <div><Label>Custom headers (JSON)</Label><Input value={editForm.customHeaders} onChange={(e) => setEditForm({ ...editForm, customHeaders: e.target.value })} placeholder='{"X-Org":"acme"}' /></div>}
            {editForm.providerKind !== 'compatible' && <div className="space-y-2 rounded-md border p-3"><Label>Client configuration</Label><p className="text-xs text-muted-foreground">Import a model first. Replace the placeholders and set the gateway key in the client environment. Use HTTPS for remote clients.</p>{editForm.providerKind === 'codex' && <p className="text-xs text-muted-foreground">To use a Codex native combo or its alias, replace the model value below with its exact public model ID or alias. Scope LATEDEV_API_KEY to that target and leave token caps empty. Sign in and test from the Codex client.</p>}<pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{integrationHelp(editForm.providerKind, editingProvider?.slug ?? editForm.slug)}</pre><Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(integrationHelp(editForm.providerKind, editingProvider?.slug ?? editForm.slug)).then(() => toast.success('Configuration copied'), () => toast.error('Clipboard unavailable')); }}>Copy configuration</Button></div>}
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
    </div>
  );
}
