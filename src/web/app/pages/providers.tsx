// Providers page — list + create form.
import { Fragment, useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Plus, Play, Trash2, Upload, Settings2 } from 'lucide-react';
import { CodexImportDialog } from '../../components/codex-import-dialog';

interface Provider {
  id: string; name: string; slug: string; type: 'openai' | 'anthropic' | 'codex'; baseUrl: string;
  enabled: boolean; health: string; modelCount: number;
}

interface CodexAccount {
  id: string; email: string | null; accountIdMasked: string | null; workspaceIdMasked: string | null;
  planType: string | null; tokenExpiresAt: string; enabled: boolean; healthState: string;
  lastRefreshAt: string | null; priority: number;
}

const EMPTY = { name: '', slug: '', type: 'openai' as 'openai' | 'anthropic' | 'codex', baseUrl: 'https://api.openai.com', apiKey: '', customHeaders: '', enabled: true };

export function Providers() {
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<typeof EMPTY>(EMPTY);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [codexAccounts, setCodexAccounts] = useState<Record<string, CodexAccount[]>>({});
  const requiresApiKey = form.type !== 'codex';
  const [importProviderId, setImportProviderId] = useState<string | null>(null);
  const [accountAction, setAccountAction] = useState<string | null>(null);

  const reloadCodex = async (providerId: string) => {
    try { const result = await api.get<{ accounts: CodexAccount[] }>(`/api/admin/codex/accounts?providerId=${encodeURIComponent(providerId)}`); setCodexAccounts((current) => ({ ...current, [providerId]: result.accounts })); }
    catch (e) { toast.error((e as Error).message || 'Unable to load Codex accounts'); }
  };
  const reload = async () => {
    try {
      const result = await api.get<{ providers: Provider[] }>('/api/admin/providers');
      setRows(result.providers);
      await Promise.all(result.providers.filter((provider) => provider.type === 'codex').map((provider) => reloadCodex(provider.id)));
    } catch (e) { toast.error((e as Error).message || 'Unable to load providers'); }
  };
  // reload is intentionally stable for the page lifetime; mutations call it explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Runs after the AlertDialog confirmation — deletingId is the row under deletion.
  const updateAccount = async (account: CodexAccount, changes: Record<string, unknown>) => {
    setAccountAction(account.id);
    try { await api.patch(`/api/admin/codex/accounts/${account.id}`, changes); toast.success('Codex account updated'); const provider = rows.find((item) => codexAccounts[item.id]?.some((row) => row.id === account.id)); if (provider) await reloadCodex(provider.id); }
    catch (e) { toast.error((e as Error).message || 'Unable to update Codex account'); }
    finally { setAccountAction(null); }
  };
  const testAccount = async (account: CodexAccount) => {
    setAccountAction(account.id);
    try { await api.post(`/api/admin/codex/accounts/${account.id}/test`); toast.success('Codex account test passed'); }
    catch (e) { toast.error((e as Error).message || 'Codex account test failed'); }
    finally { setAccountAction(null); }
  };
  const deleteAccount = async (account: CodexAccount) => {
    setAccountAction(account.id);
    try { await api.del(`/api/admin/codex/accounts/${account.id}`); toast.success('Codex account deleted'); const provider = rows.find((item) => codexAccounts[item.id]?.some((row) => row.id === account.id)); if (provider) await reloadCodex(provider.id); }
    catch (e) { toast.error((e as Error).message || 'Unable to delete Codex account'); }
    finally { setAccountAction(null); }
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
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-1 h-4 w-4" /> Add provider</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New provider</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>Slug (optional)</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></div>
              <div><Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as 'openai' | 'anthropic' | 'codex' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI-compatible</SelectItem>
                    <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                    <SelectItem value="codex">Codex OAuth</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Base URL</Label><Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></div>
              <div><Label>API key</Label><Input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>
              <div><Label>Custom headers (JSON)</Label><Input value={form.customHeaders} onChange={(e) => setForm({ ...form, customHeaders: e.target.value })} placeholder='{"X-Org":"acme"}' /></div>
              <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><Label>Enabled</Label></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={submitting || !form.name || (requiresApiKey && !form.apiKey)} onClick={submit}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
                      <Button size="sm" variant="outline" disabled={testingId === p.id} onClick={() => test(p.id)}><Play className="h-3 w-3" /></Button>
                      <Button size="sm" variant="outline" onClick={() => startEdit(p)}>✎</Button>
                      <Button size="sm" variant="outline" onClick={() => setDeletingId(p.id)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
                {p.type === 'codex' && <TableRow><TableCell colSpan={7} className="bg-muted/30 p-4">
                  <div className="mb-3 flex items-center justify-between"><div><h3 className="font-medium">Codex accounts</h3><p className="text-xs text-muted-foreground">OAuth accounts are masked and never expose token fields.</p></div><Button size="sm" onClick={() => setImportProviderId(p.id)}><Upload className="mr-1 h-4 w-4" /> Import accounts</Button></div>
                  {(codexAccounts[p.id] ?? []).length === 0 ? <p className="py-3 text-sm text-muted-foreground">No Codex accounts imported yet.</p> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Email / identity</TableHead><TableHead>Plan</TableHead><TableHead>Expiry</TableHead><TableHead>Health</TableHead><TableHead>Last refresh</TableHead><TableHead>Priority</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{(codexAccounts[p.id] ?? []).map((account) => <TableRow key={account.id}><TableCell><div>{account.email || 'Unknown email'}</div><div className="text-xs text-muted-foreground">{account.accountIdMasked || '—'}{account.workspaceIdMasked ? ` · ${account.workspaceIdMasked}` : ''}</div></TableCell><TableCell>{account.planType || '—'}</TableCell><TableCell>{new Date(account.tokenExpiresAt).toLocaleDateString()}</TableCell><TableCell><Badge variant={account.healthState === 'healthy' ? 'success' : account.healthState === 'down' ? 'destructive' : 'secondary'}>{account.healthState}</Badge></TableCell><TableCell>{account.lastRefreshAt ? new Date(account.lastRefreshAt).toLocaleString() : '—'}</TableCell><TableCell><Input aria-label={`Priority for ${account.email || account.id}`} className="w-20" type="number" value={account.priority} onChange={(event) => void updateAccount(account, { priority: Number(event.target.value) })} /></TableCell><TableCell><div className="flex gap-1"><Button size="sm" variant="outline" disabled={accountAction === account.id} onClick={() => void updateAccount(account, { enabled: !account.enabled })}>{account.enabled ? 'Disable' : 'Enable'}</Button><Button size="sm" variant="outline" aria-label={`Test Codex account ${account.email || account.id}`} disabled={accountAction === account.id} onClick={() => void testAccount(account)}><Settings2 className="h-3 w-3" /></Button><Button size="sm" variant="destructive" disabled={accountAction === account.id} onClick={() => { if (window.confirm('Delete this Codex account?')) void deleteAccount(account); }}>Delete</Button></div></TableCell></TableRow>)}</TableBody></Table></div>}
                </TableCell></TableRow>}
                </Fragment>
              ))}
              {importProviderId && <CodexImportDialog providerId={importProviderId} open onOpenChange={(open) => { if (!open) setImportProviderId(null); }} onImported={() => void reloadCodex(importProviderId)} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingId} onOpenChange={(open) => { if (!open) { setEditingId(null); setEditForm(EMPTY); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit provider</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div><Label>Slug (optional)</Label><Input value={editForm.slug} onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })} /></div>
            <div><Label>Type</Label>
              <Select value={editForm.type} onValueChange={(v) => setEditForm({ ...editForm, type: v as 'openai' | 'anthropic' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                  <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
                  <SelectItem value="codex">Codex OAuth</SelectItem>
                  </SelectContent>
              </Select>
            </div>
            <div><Label>Base URL</Label><Input value={editForm.baseUrl} onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })} /></div>
            <div><Label>API key (leave empty to keep current)</Label><Input type="password" value={editForm.apiKey} onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })} /></div>
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
