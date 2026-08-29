// Providers page — list + create form.
import { useEffect, useState } from 'react';
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
import { Plus, Play, Trash2 } from 'lucide-react';

interface Provider {
  id: string; name: string; slug: string; type: 'openai' | 'anthropic'; baseUrl: string;
  enabled: boolean; health: string; modelCount: number;
}

const EMPTY = { name: '', slug: '', type: 'openai' as 'openai' | 'anthropic', baseUrl: 'https://api.openai.com', apiKey: '', customHeaders: '', enabled: true };

export function Providers() {
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<typeof EMPTY>(EMPTY);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = () => api.get<{ providers: Provider[] }>('/api/admin/providers').then((r) => setRows(r.providers));
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

  const del = async (id: string) => {
    setDeletingId(id);
    try { await api.del(`/api/admin/providers/${id}`); toast.success('Provider removed'); void reload(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setDeletingId(null); }
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
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as 'openai' | 'anthropic' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI-compatible</SelectItem>
                    <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
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
              <Button disabled={submitting || !form.name || !form.apiKey} onClick={submit}>Create</Button>
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
                <TableRow key={p.id}>
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
                      <Button size="sm" variant="outline" disabled={deletingId === p.id} onClick={() => del(p.id)}><Trash2 className="h-3 w-3" /></Button>
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
            <AlertDialogAction disabled={!!deletingId} onClick={() => deletingId && del(deletingId)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
