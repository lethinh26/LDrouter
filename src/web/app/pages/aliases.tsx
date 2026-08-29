// Aliases page.
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

interface Alias { id: string; alias: string; targetKind: 'model' | 'combo'; targetId: string; targetName: string | null; enabled: boolean; }
interface Model { id: string; publicModelId: string; }
interface Combo { id: string; publicModelId: string; }

export function Aliases() {
  const [rows, setRows] = useState<Alias[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ alias: '', targetKind: 'model' as 'model' | 'combo', targetId: '', enabled: true });

  const reload = async () => {
    const [a, m, c] = await Promise.all([
      api.get<{ aliases: Alias[] }>('/api/admin/aliases'),
      api.get<{ models: Model[] }>('/api/admin/models'),
      api.get<{ combos: Combo[] }>('/api/admin/combos'),
    ]);
    setRows(a.aliases); setModels(m.models); setCombos(c.combos);
  };
  useEffect(() => { void reload(); }, []);

  const submit = async () => {
    try {
      await api.post('/api/admin/aliases', form);
      toast.success('Alias created'); setOpen(false);
      setForm({ alias: '', targetKind: 'model', targetId: '', enabled: true });
      void reload();
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <PageHeader title="Aliases" description="Stable client-visible names for models or combos" actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-1 h-4 w-4" /> New alias</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New alias</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Alias</Label><Input value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} placeholder="coding" /></div>
              <div><Label>Target type</Label>
                <Select value={form.targetKind} onValueChange={(v) => setForm({ ...form, targetKind: v as 'model' | 'combo' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="model">Model</SelectItem><SelectItem value="combo">Combo</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label>Target</Label>
                <Select value={form.targetId} onValueChange={(v) => setForm({ ...form, targetId: v })}>
                  <SelectTrigger><SelectValue placeholder="Choose target" /></SelectTrigger>
                  <SelectContent>
                    {(form.targetKind === 'model' ? models : combos).map((x) => <SelectItem key={x.id} value={x.id}>{x.publicModelId}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><Label>Enabled</Label></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!form.alias || !form.targetId} onClick={submit}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      } />
      <Card>
        <CardHeader><CardTitle className="text-base">All aliases</CardTitle><CardDescription>{rows.length} total</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Alias</TableHead><TableHead>Target</TableHead><TableHead>Type</TableHead><TableHead>Enabled</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No aliases yet.</TableCell></TableRow>}
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">{a.alias}</TableCell>
                  <TableCell className="font-mono text-xs">{a.targetName ?? a.targetId}</TableCell>
                  <TableCell><Badge variant="outline">{a.targetKind}</Badge></TableCell>
                  <TableCell>{a.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" onClick={async () => { await api.del(`/api/admin/aliases/${a.id}`); toast.success('Removed'); void reload(); }}>Delete</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
