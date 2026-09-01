// API keys page: create / list / delete / enable/disable.
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '../../components/ui/dialog';
import { Switch } from '../../components/ui/switch';
import { Checkbox } from '../../components/ui/checkbox';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Plus, Copy, Eye, Trash2, Ban, CheckCircle2, Pencil } from 'lucide-react';

interface KeyRow { id: string; name: string; keyPrefix: string; enabled: boolean; expiresAt: string | null; lastUsedAt: string | null; allowAllModels: boolean; modelScopeCount: number; rpmLimit: number | null; tpmLimit: number | null; concurrencyLimit: number | null; secret: string | null; }
interface Model { id: string; publicModelId: string; }
interface Combo { id: string; publicModelId: string; }
interface Perm { targetKind: 'model' | 'combo'; targetId: string; }

export function ApiKeys() {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ secret: string; name: string } | null>(null);
  const [revealRow, setRevealRow] = useState<{ secret: string; name: string } | null>(null);
  const [form, setForm] = useState({ name: '', expiresAt: '', allowAll: true, permissions: [] as Perm[], rpmLimit: '', tpmLimit: '', concurrency: '', customSecret: '' });

  const reload = async () => {
    const [k, m, c] = await Promise.all([
      api.get<{ apiKeys: KeyRow[] }>('/api/admin/api-keys'),
      api.get<{ models: Model[] }>('/api/admin/models'),
      api.get<{ combos: Combo[] }>('/api/admin/combos'),
    ]);
    setRows(k.apiKeys); setModels(m.models); setCombos(c.combos);
  };
  useEffect(() => { void reload(); }, []);

  const submit = async () => {
    try {
      if (editingId) {
        await api.patch('/api/admin/api-keys', {
          id: editingId,
          name: form.name,
          expiresAt: form.expiresAt || null,
          allowAllModels: form.allowAll,
          permissions: form.allowAll ? [] : form.permissions,
          rpmLimit: form.rpmLimit ? Number(form.rpmLimit) : null,
          tpmLimit: form.tpmLimit ? Number(form.tpmLimit) : null,
          maxConcurrent: form.concurrency ? Number(form.concurrency) : null,
        });
        setOpen(false);
        setEditingId(null);
        setForm({ name: '', expiresAt: '', allowAll: true, permissions: [], rpmLimit: '', tpmLimit: '', concurrency: '', customSecret: '' });
        toast.success('Key updated');
        void reload();
        return;
      }
      const r = await api.post<{ secret: string; name: string }>('/api/admin/api-keys', {
        name: form.name,
        expiresAt: form.expiresAt || null,
        allowAllModels: form.allowAll,
        permissions: form.allowAll ? undefined : form.permissions,
        rpmLimit: form.rpmLimit ? Number(form.rpmLimit) : null,
        tpmLimit: form.tpmLimit ? Number(form.tpmLimit) : null,
        maxConcurrent: form.concurrency ? Number(form.concurrency) : null,
        ...(form.customSecret.trim() ? { secret: form.customSecret.trim() } : {}),
      });
      setOpen(false);
      setReveal({ secret: r.secret, name: r.name });
      setForm({ name: '', expiresAt: '', allowAll: true, permissions: [], rpmLimit: '', tpmLimit: '', concurrency: '', customSecret: '' });
      void reload();
    } catch (e) { toast.error((e as Error).message); }
  };

  const openEdit = async (k: KeyRow) => {
    try {
      const detail = await api.get<{ apiKey: { permissions: Perm[] } }>(`/api/admin/api-keys/${k.id}`);
      const perms = (detail.apiKey.permissions ?? []).filter((p) => p.targetKind === 'model' || p.targetKind === 'combo');
      setEditingId(k.id);
      setForm({
        name: k.name,
        expiresAt: k.expiresAt ? k.expiresAt.slice(0, 16) : '',
        allowAll: k.allowAllModels,
        permissions: perms,
        rpmLimit: k.rpmLimit != null ? String(k.rpmLimit) : '',
        tpmLimit: k.tpmLimit != null ? String(k.tpmLimit) : '',
        concurrency: k.concurrencyLimit != null ? String(k.concurrencyLimit) : '',
        customSecret: '', // the secret is never changed on edit
      });
      setOpen(true);
    } catch (e) { toast.error((e as Error).message); }
  };

  const cancelEdit = () => {
    setOpen(false);
    setEditingId(null);
    setForm({ name: '', expiresAt: '', allowAll: true, permissions: [], rpmLimit: '', tpmLimit: '', concurrency: '', customSecret: '' });
  };

  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.patch('/api/admin/api-keys', { id, enabled: !enabled });
      toast.success(enabled ? 'Key disabled' : 'Key enabled');
      void reload();
    } catch (e) { toast.error((e as Error).message); }
  };

  const del = async (id: string) => {
    if (!window.confirm('Delete this API key? This cannot be undone.')) return;
    try {
      await api.del(`/api/admin/api-keys/${id}`);
      toast.success('Key deleted');
      void reload();
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <PageHeader title="API Keys" description="Gateway bearer keys for client applications" actions={
        <Dialog open={open} onOpenChange={(o) => { if (!o) cancelEdit(); else setOpen(true); }}>
          <DialogTrigger asChild><Button><Plus className="mr-1 h-4 w-4" /> New key</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>{editingId ? 'Edit API key' : 'New API key'}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>Expires (optional)</Label><Input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></div>
              <div className="grid grid-cols-3 gap-2">
                <div><Label>RPM limit</Label><Input value={form.rpmLimit} onChange={(e) => setForm({ ...form, rpmLimit: e.target.value })} type="number" /></div>
                <div><Label>TPM limit</Label><Input value={form.tpmLimit} onChange={(e) => setForm({ ...form, tpmLimit: e.target.value })} type="number" /></div>
                <div><Label>Concurrency</Label><Input value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} type="number" /></div>
              </div>
              {!editingId && (
                <div><Label>Key value (optional)</Label><Input value={form.customSecret} onChange={(e) => setForm({ ...form, customSecret: e.target.value })} placeholder="Leave empty to auto-generate ld-…" /><p className="text-xs text-muted-foreground">If provided, this exact value is stored as the key. Otherwise a random ld-… key is generated.</p></div>
              )}
              <div className="flex items-center gap-2"><Switch checked={form.allowAll} onCheckedChange={(v) => setForm({ ...form, allowAll: v })} /><Label>Allow all current and future models</Label></div>
              {!form.allowAll && (
                <div>
                  <Label>Scope</Label>
                  <div className="max-h-48 space-y-1 overflow-auto rounded border p-2">
                    {[...models.map((m) => ({ targetKind: 'model' as const, targetId: m.id, label: m.publicModelId })), ...combos.map((c) => ({ targetKind: 'combo' as const, targetId: c.id, label: c.publicModelId }))].map((t) => {
                      const on = form.permissions.some((p) => p.targetKind === t.targetKind && p.targetId === t.targetId);
                      return (
                        <label key={`${t.targetKind}:${t.targetId}`} className="flex items-center gap-2 rounded p-1 text-sm hover:bg-accent">
                          <Checkbox
                            checked={on}
                            onCheckedChange={(c) => {
                              setForm((f) => ({ ...f, permissions: c ? [...f.permissions, { targetKind: t.targetKind, targetId: t.targetId }] : f.permissions.filter((p) => !(p.targetKind === t.targetKind && p.targetId === t.targetId)) }));
                            }}
                          />
                          <span className="font-mono text-xs">{t.label}</span>
                          <Badge variant="outline" className="ml-1">{t.targetKind}</Badge>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={cancelEdit}>Cancel</Button>
              <Button disabled={!form.name} onClick={submit}>{editingId ? 'Save changes' : 'Create'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      } />
      <Card>
        <CardHeader><CardTitle className="text-base">All keys</CardTitle><CardDescription>{rows.length} total</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Prefix</TableHead><TableHead>Status</TableHead><TableHead>Scope</TableHead><TableHead>RPM/TPM/Conc</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No API keys yet.</TableCell></TableRow>}
              {rows.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">{k.keyPrefix}…</TableCell>
                  <TableCell>{k.enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="destructive">disabled</Badge>}</TableCell>
                  <TableCell>{k.allowAllModels ? 'all' : `${k.modelScopeCount} scoped`}</TableCell>
                  <TableCell className="text-xs">{[k.rpmLimit, k.tpmLimit, k.concurrencyLimit].map((v, i) => v ? ['', 'RPM', 'TPM', 'Conc'][i + 1] : null).filter(Boolean).join(' / ') || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {k.secret && (
                        <>
                          <Button size="sm" variant="ghost" title="Copy secret" onClick={() => { void navigator.clipboard.writeText(k.secret!); toast.success('Copied'); }}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Show secret" onClick={() => setRevealRow({ secret: k.secret!, name: k.name })}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="ghost" title="Edit" onClick={() => void openEdit(k)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => toggle(k.id, k.enabled)}>
                        {k.enabled ? <Ban className="mr-1 h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                        {k.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => del(k.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!reveal} onOpenChange={(o) => { if (!o) setReveal(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>Copy now — this secret will not be shown again.</DialogDescription>
          </DialogHeader>
          <div className="rounded border bg-muted p-3 font-mono text-xs break-all">{reveal?.secret}</div>
          <DialogFooter>
            <Button onClick={() => { if (reveal) { void navigator.clipboard.writeText(reveal.secret); toast.success('Copied'); } }}><Copy className="mr-1 h-4 w-4" /> Copy</Button>
            <Button variant="outline" onClick={() => setReveal(null)}>I have saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealRow} onOpenChange={(o) => { if (!o) setRevealRow(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key: {revealRow?.name}</DialogTitle>
            <DialogDescription>Full secret for this key, readable any time.</DialogDescription>
          </DialogHeader>
          <div className="rounded border bg-muted p-3 font-mono text-xs break-all">{revealRow?.secret}</div>
          <DialogFooter>
            <Button onClick={() => { if (revealRow) { void navigator.clipboard.writeText(revealRow.secret); toast.success('Copied'); } }}><Copy className="mr-1 h-4 w-4" /> Copy</Button>
            <Button variant="outline" onClick={() => setRevealRow(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
