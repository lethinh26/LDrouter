// Combos page.
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';

interface Combo { id: string; name: string; slug: string; publicModelId: string; mode: string; enabled: boolean; memberCount: number; healthyMemberCount: number; }
interface ModelRow { id: string; publicModelId: string; displayName: string; }

export function Combos() {
  const [combos, setCombos] = useState<Combo[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', mode: 'fallback' as 'fallback' | 'weighted_round_robin', enabled: true, members: [] as Array<{ modelId: string; weight: number; position: number; enabled: boolean }> });

  const reload = async () => {
    const [c, m] = await Promise.all([
      api.get<{ combos: Combo[] }>('/api/admin/combos'),
      api.get<{ models: ModelRow[] }>('/api/admin/models'),
    ]);
    setCombos(c.combos);
    setModels(m.models);
  };
  useEffect(() => { void reload(); }, []);

  const addMember = (modelId: string) => {
    setForm((f) => ({ ...f, members: [...f.members, { modelId, weight: 1, position: f.members.length, enabled: true }] }));
  };
  const removeMember = (idx: number) => {
    setForm((f) => ({ ...f, members: f.members.filter((_, i) => i !== idx).map((m, i) => ({ ...m, position: i })) }));
  };

  const submit = async () => {
    if (form.members.length === 0) { toast.error('Add at least one member'); return; }
    try {
      await api.post('/api/admin/combos', { name: form.name, slug: form.slug || undefined, mode: form.mode, enabled: form.enabled, members: form.members });
      toast.success('Combo created');
      setOpen(false); setForm({ name: '', slug: '', mode: 'fallback', enabled: true, members: [] });
      void reload();
    } catch (e) { toast.error((e as Error).message); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this combo?')) return;
    try { await api.del(`/api/admin/combos/${id}`); toast.success('Combo removed'); void reload(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <PageHeader title="Combos" description="Virtual models combining physical models" actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-1 h-4 w-4" /> New combo</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>New combo</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>Slug</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></div>
              <div><Label>Mode</Label>
                <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as 'fallback' | 'weighted_round_robin' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fallback">Fallback (ordered)</SelectItem>
                    <SelectItem value="weighted_round_robin">Weighted round-robin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><Label>Enabled</Label></div>
              <div>
                <Label>Members</Label>
                <Select onValueChange={addMember}>
                  <SelectTrigger><SelectValue placeholder="Add a model" /></SelectTrigger>
                  <SelectContent>
                    {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.publicModelId}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="mt-2 space-y-1">
                  {form.members.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 rounded border p-2 text-sm">
                      <span className="font-mono text-xs">{models.find((x) => x.id === m.modelId)?.publicModelId}</span>
                      <Input type="number" min={1} value={m.weight} onChange={(e) => { const v = Number(e.target.value); setForm((f) => ({ ...f, members: f.members.map((mm, j) => j === i ? { ...mm, weight: v } : mm) })); }} className="w-20" />
                      <Button size="sm" variant="outline" onClick={() => removeMember(i)}>Remove</Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!form.name} onClick={submit}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      } />
      <Card>
        <CardHeader><CardTitle className="text-base">All combos</CardTitle><CardDescription>{combos.length} total</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Public ID</TableHead><TableHead>Mode</TableHead><TableHead>Members</TableHead><TableHead>Healthy</TableHead><TableHead>Enabled</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {combos.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No combos yet.</TableCell></TableRow>}
              {combos.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">{c.publicModelId}</TableCell>
                  <TableCell><Badge variant="outline">{c.mode}</Badge></TableCell>
                  <TableCell>{c.memberCount}</TableCell>
                  <TableCell>{c.healthyMemberCount}</TableCell>
                  <TableCell>{c.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => del(c.id)}>Delete</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
