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
import { Plus, Edit, Trash2, Search, X, GripVertical } from 'lucide-react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '../../lib/utils';

interface Combo { id: string; name: string; slug: string; publicModelId: string; mode: string; enabled: boolean; memberCount: number; healthyMemberCount: number; }
interface ComboDetail extends Combo { members: Array<{ id: string; modelId: string; publicModelId: string; displayName: string; providerSlug: string; position: number; weight: number; enabled: boolean }>; }
interface ModelRow { id: string; publicModelId: string; displayName: string; }
interface MemberForm { id?: string; modelId: string; position: number; weight: number; enabled: boolean }

// Priority is the array order: index 0 is tried first in fallback mode and leads
// the rotation in weighted round-robin.
const reindex = (members: MemberForm[]) => members.map((m, i) => ({ ...m, position: i }));

export function Combos() {
  const [combos, setCombos] = useState<Combo[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', mode: 'fallback' as 'fallback' | 'weighted_round_robin', enabled: true, members: [] as MemberForm[] });
  const [editForm, setEditForm] = useState({ name: '', slug: '', mode: 'fallback' as 'fallback' | 'weighted_round_robin', enabled: true, members: [] as typeof form.members });

  const reload = async () => {
    const [c, m] = await Promise.all([
      api.get<{ combos: Combo[] }>('/api/admin/combos'),
      api.get<{ models: ModelRow[] }>('/api/admin/models'),
    ]);
    setCombos(c.combos);
    setModels(m.models);
  };
  useEffect(() => { void reload(); }, []);

  const submit = async () => {
    if (form.members.length === 0) { toast.error('Add at least one member'); return; }
    setCreating(true);
    try {
      await api.post('/api/admin/combos', { name: form.name, slug: form.slug || undefined, mode: form.mode, enabled: form.enabled, members: form.members });
      toast.success('Combo created');
      setOpen(false); setForm({ name: '', slug: '', mode: 'fallback', enabled: true, members: [] });
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setCreating(false); }
  };

  // --- Edit combo ---
  const openEdit = async (c: Combo) => {
    try {
      const r = await api.get<{ combo: ComboDetail }>(`/api/admin/combos/${c.id}`);
      const d = r.combo;
      setEditingId(d.id);
      setEditForm({
        name: d.name,
        // The server derives `slug` from the name for slugless combos, but
        // `publicModelId` is the real switch for the "combo/" prefix. Seeding the
        // box from `slug` made every "open edit → save" round-trip look like the
        // operator had typed a slug, which re-prefixed the model ID.
        slug: d.publicModelId.startsWith('combo/') ? d.slug : '',
        mode: d.mode as 'fallback' | 'weighted_round_robin',
        enabled: d.enabled,
        members: d.members.map((m) => ({ modelId: m.modelId, weight: m.weight, position: m.position, enabled: m.enabled })),
      });
      setEditOpen(true);
    } catch (e) { toast.error((e as Error).message); }
  };

  const submitEdit = async () => {
    if (!editingId) return;
    if (editForm.members.length === 0) { toast.error('Add at least one member'); return; }
    setEditing(true);
    try {
      await api.patch('/api/admin/combos', { id: editingId, name: editForm.name, slug: editForm.slug || undefined, mode: editForm.mode, enabled: editForm.enabled, members: editForm.members });
      toast.success('Combo updated');
      setEditOpen(false); setEditingId(null);
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setEditing(false); }
  };

  // Separate handlers per dialog: a single `addMember` that only wrote `editForm`
  // was wired into BOTH pickers, so "+ Add" in the New-combo dialog silently
  // mutated the edit form and the create list stayed empty (the button looked
  // dead). Each dialog owns its own member list.
  const addMember = (modelId: string) => {
    setForm((f) => ({ ...f, members: reindex([...f.members, { modelId, weight: 1, position: f.members.length, enabled: true }]) }));
  };

  const addEditMember = (modelId: string) => {
    setEditForm((f) => ({ ...f, members: reindex([...f.members, { modelId, weight: 1, position: f.members.length, enabled: true }]) }));
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
              <div><Label>Slug (optional — empty uses the name as the model ID)</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="empty → gpt-5.5 · set → combo/gpt-5.5" /></div>
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
                <Label>Members — priority order · drag to reorder</Label>
                <MemberPicker models={models} addedIds={form.members.map((m) => m.modelId)} onAdd={addMember} />
                <MemberList
                  className="mt-2"
                  members={form.members}
                  label={(m) => models.find((x) => x.id === m.modelId)?.publicModelId ?? m.modelId}
                  onChange={(members) => setForm((f) => ({ ...f, members }))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!form.name || creating} onClick={submit}>{creating ? 'Creating…' : 'Create'}</Button>
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
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => void openEdit(c)}><Edit className="h-3.5 w-3.5" /> Sửa</Button>
                      <Button size="sm" variant="destructive" onClick={() => del(c.id)}><Trash2 className="h-3.5 w-3.5" /> Xoá</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit combo dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Edit combo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div><Label>Slug (optional — leave empty to use the name as the model ID)</Label><Input value={editForm.slug} onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })} placeholder="empty → gpt-5.5 · set → combo/gpt-5.5" /></div>
            <div><Label>Mode</Label>
              <Select value={editForm.mode} onValueChange={(v) => setEditForm({ ...editForm, mode: v as 'fallback' | 'weighted_round_robin' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fallback">Fallback (ordered)</SelectItem>
                  <SelectItem value="weighted_round_robin">Weighted round-robin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2"><Switch checked={editForm.enabled} onCheckedChange={(v) => setEditForm({ ...editForm, enabled: v })} /><Label>Enabled</Label></div>
            <div>
              <Label>Members — priority order · drag to reorder</Label>
              <MemberPicker models={models} addedIds={editForm.members.map((m) => m.modelId)} onAdd={addEditMember} />
              <MemberList
                className="mt-2"
                members={editForm.members}
                label={(m) => models.find((x) => x.id === m.modelId)?.publicModelId ?? m.modelId}
                onChange={(members) => setEditForm((f) => ({ ...f, members }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button disabled={!editForm.name || editing} onClick={submitEdit}>{editing ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Drag-sortable member rows: the row order IS the routing priority that gets saved
// as member.position (0 = highest priority), like the Codex account pool.
function MemberList({ members, label, onChange, className }: {
  members: MemberForm[];
  label: (member: MemberForm) => string;
  onChange: (members: MemberForm[]) => void;
  className?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (members.length === 0) return <p className={cn('text-xs text-muted-foreground', className)}>No members yet — add at least one.</p>;
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onChange(reindex(arrayMove(members, Number(active.id), Number(over.id))));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
      <SortableContext items={members.map((_, i) => i)} strategy={verticalListSortingStrategy}>
        <div className={cn('space-y-1', className)}>
          {members.map((m, i) => (
            <MemberRow
              key={m.id ?? m.modelId}
              index={i}
              member={m}
              label={label(m)}
              onWeight={(weight) => onChange(members.map((mm, j) => (j === i ? { ...mm, weight } : mm)))}
              onRemove={() => onChange(reindex(members.filter((_, j) => j !== i)))}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** One member row. Separate because useSortable is a hook and must run per row. */
function MemberRow({ index, member, label, onWeight, onRemove }: {
  index: number;
  member: MemberForm;
  label: string;
  onWeight: (weight: number) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: index });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn('flex items-center gap-2 rounded border p-2 text-sm', isDragging && 'relative z-10 bg-muted/60 shadow-sm')}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        title="Drag to change priority"
        className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="w-5 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
      <span className="flex-1 font-mono text-xs">{label}</span>
      <Input type="number" min={1} value={member.weight} onChange={(e) => onWeight(Number(e.target.value))} className="w-20" aria-label={`Weight for ${label}`} />
      <Button size="sm" variant="outline" onClick={onRemove}>Remove</Button>
    </div>
  );
}

// Searchable model picker used to add members to a combo (create + edit).
function MemberPicker({ models, addedIds, onAdd }: { models: ModelRow[]; addedIds: string[]; onAdd: (modelId: string) => void }) {
  const [q, setQ] = useState('');
  const filtered = q
    ? models.filter((m) => {
      const s = q.toLowerCase();
      return m.publicModelId.toLowerCase().includes(s) || m.displayName.toLowerCase().includes(s);
    })
    : models;
  const available = filtered.filter((m) => !addedIds.includes(m.id));
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="pl-8" placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground" onClick={() => setQ('')}><X className="h-4 w-4" /></button>}
      </div>
      {available.length === 0 ? (
        <p className="text-xs text-muted-foreground">No models match.</p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-auto rounded border p-1">
          {available.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded p-1 text-sm hover:bg-accent">
              <span className="font-mono text-xs">{m.publicModelId}</span>
              <Button size="sm" variant="ghost" onClick={() => onAdd(m.id)}>+ Add</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
