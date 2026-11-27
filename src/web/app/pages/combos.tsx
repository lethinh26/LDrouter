// Combos page.
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../components/ui/alert-dialog';
import { Switch } from '../../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Plus, Edit, Trash2, Search, X, GripVertical, ChevronUp, ChevronDown, Play, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '../../lib/utils';

type ComboKind = 'standard' | 'codex_native';
interface Combo { id: string; name: string; slug: string; publicModelId: string; comboKind: ComboKind; enabled: boolean; memberCount: number; healthyMemberCount: number; slowCooldownCount: number; slowProbeCount: number; status: string; unavailableReasons: string[]; capabilityWarnings: string[]; }
interface SlowStateView { modelId: string; workload: string; latencyKind: 'ttft' | 'completion'; medianLatencyMs: number | null; sampleCount: number; consecutiveSlowCount: number; relativeSlowCount: number; degraded: 'absolute' | 'relative' | null; comparatorModelId: string | null; probeDueMs: number | null; probeLeaseUntilMs: number | null; recoverySuccesses: number; lastLatencyMs: number | null; updatedAtMs: number; state: string }
interface ComboDetail extends Combo { maxTotalAttempts: number; maxRequestDurationSeconds: number | null; fallbackOnConnection: boolean; fallbackOnConnectTimeout: boolean; fallbackOnFirstTokenTimeout: boolean; fallbackOnTotalTimeout: boolean; fallbackOn408: boolean; fallbackOn429: boolean; fallbackOn5xx: boolean; slowResponseFallbackEnabled: boolean; slowResponseThresholdSeconds: number; slowResponseMaxCount: number; members: Array<{ id: string; modelId: string; publicModelId: string; upstreamModelId: string; displayName: string; providerSlug: string; position: number; enabled: boolean; upstreamAvailable: boolean; providerEnabled: boolean; providerHealth: string; circuitOpen: boolean; capabilities: Record<string, unknown>; status: { state: string; reason: string }; adaptiveStates: SlowStateView[] }>; capabilityWarnings: string[]; }
interface ModelRow { id: string; publicModelId: string; upstreamModelId: string; displayName: string; providerSlug: string; providerKind?: string; enabled: boolean; upstreamAvailable: boolean; providerEnabled: boolean; providerHealth: string; providerTotalTimeoutMs: number | null; circuitOpen: boolean; capabilities: Record<string, unknown>; }
interface MemberForm { id?: string; modelId: string; position: number; enabled: boolean }
interface ComboTestResult {
  success: boolean;
  text: string;
  latencyMs: number;
  selectedModel: { publicModelId: string; upstreamModelId: string; providerSlug: string } | null;
  attempts: Array<{ publicModelId: string; upstreamModelId: string; providerName: string; latencyMs: number; success: boolean; selectionReason: string; failureReason: string | null }>;
}

type ComboSettings = { maxTotalAttempts: number; maxRequestDurationSeconds: number | null; fallbackOnConnection: boolean; fallbackOnConnectTimeout: boolean; fallbackOnFirstTokenTimeout: boolean; fallbackOnTotalTimeout: boolean; fallbackOn408: boolean; fallbackOn429: boolean; fallbackOn5xx: boolean; slowResponseFallbackEnabled: boolean; slowResponseThresholdSeconds: number; slowResponseMaxCount: number };
const defaultComboSettings: ComboSettings = { maxTotalAttempts: 3, maxRequestDurationSeconds: null, fallbackOnConnection: true, fallbackOnConnectTimeout: true, fallbackOnFirstTokenTimeout: true, fallbackOnTotalTimeout: true, fallbackOn408: true, fallbackOn429: true, fallbackOn5xx: true, slowResponseFallbackEnabled: true, slowResponseThresholdSeconds: 60, slowResponseMaxCount: 3 };
const emptyComboForm = () => ({ name: '', slug: '', enabled: true, comboKind: 'standard' as ComboKind, ...defaultComboSettings, members: [] as MemberForm[] });
const reasonLabels: Record<string, string> = { member_disabled: 'member disabled', model_missing: 'model missing', provider_disabled: 'provider disabled', provider_down: 'provider down', model_disabled: 'model disabled', upstream_unavailable: 'upstream unavailable', circuit_open: 'circuit open', chat_capability_unavailable: 'chat capability unavailable', slow_response_cooldown: 'slow-response cooldown', slow_response_probe_active: 'recovery probe already running', slow_response_timeout: 'slow response' };
const compareAlphabetically = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Priority is the array order: index 0 is tried first.
const reindex = (members: MemberForm[]) => members.map((m, i) => ({ ...m, position: i }));

export function Combos() {
  const [combos, setCombos] = useState<Combo[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ComboTestResult | null>(null);
  const [editSlowStates, setEditSlowStates] = useState<SlowStateView[]>([]);
  const [comboSearch, setComboSearch] = useState('');
  const [form, setForm] = useState(emptyComboForm);
  const [editForm, setEditForm] = useState(emptyComboForm);
  const [deleting, setDeleting] = useState<Combo | null>(null);

  const reload = async () => {
    const [c, m] = await Promise.all([
      api.get<{ combos: Combo[] }>('/api/admin/combos'),
      api.get<{ models: ModelRow[] }>('/api/admin/models'),
    ]);
    setCombos(c.combos);
    setModels(m.models);
  };
  useEffect(() => { void reload(); }, []);

  const visibleCombos = combos
    .filter((combo) => {
      const query = comboSearch.trim().toLowerCase();
      return !query || [combo.name, combo.slug, combo.publicModelId].some((value) => value.toLowerCase().includes(query));
    })
    .sort((a, b) => compareAlphabetically(a.name || a.publicModelId, b.name || b.publicModelId)
      || compareAlphabetically(a.publicModelId, b.publicModelId));

  const testCombo = async (combo: Combo) => {
    if (combo.comboKind === 'codex_native') return;
    setTestingId(combo.id);
    try {
      setTestResult(await api.post<ComboTestResult>("/api/admin/combos/" + combo.id + "/test"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestingId(null);
    }
  };

  const submit = async () => {
    if (form.members.length === 0) { toast.error('Add at least one member'); return; }
    setCreating(true);
    try {
      await api.post('/api/admin/combos', { name: form.name, slug: form.slug.trim() || undefined, enabled: form.enabled, comboKind: form.comboKind, ...editSettings(form), members: form.members });
      toast.success('Combo created');
      setOpen(false); setForm(emptyComboForm());
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
        comboKind: d.comboKind,
        // The server derives `slug` from the name for slugless combos, but
        // `publicModelId` is the real switch for the "combo/" prefix. Seeding the
        // box from `slug` made every "open edit → save" round-trip look like the
        // operator had typed a slug, which re-prefixed the model ID.
        slug: d.publicModelId.startsWith('combo/') ? d.slug : '',
        enabled: d.enabled,
        maxTotalAttempts: d.maxTotalAttempts,
        maxRequestDurationSeconds: d.maxRequestDurationSeconds,
        fallbackOnConnection: d.fallbackOnConnection,
        fallbackOnConnectTimeout: d.fallbackOnConnectTimeout,
        fallbackOnFirstTokenTimeout: d.fallbackOnFirstTokenTimeout,
        fallbackOnTotalTimeout: d.fallbackOnTotalTimeout,
        fallbackOn408: d.fallbackOn408,
        fallbackOn429: d.comboKind === 'codex_native' ? false : d.fallbackOn429,
        fallbackOn5xx: d.fallbackOn5xx,
        slowResponseFallbackEnabled: d.comboKind === 'codex_native' ? false : d.slowResponseFallbackEnabled,
        slowResponseThresholdSeconds: d.slowResponseThresholdSeconds,
        slowResponseMaxCount: d.slowResponseMaxCount,
        members: d.members.map((m) => ({ modelId: m.modelId, position: m.position, enabled: m.enabled })),
      });
      setEditSlowStates(d.members.flatMap((member) => member.adaptiveStates));
      setEditOpen(true);
    } catch (e) { toast.error((e as Error).message); }
  };

  const submitEdit = async () => {
    if (!editingId) return;
    if (editForm.members.length === 0) { toast.error('Add at least one member'); return; }
    setEditing(true);
    try {
      await api.patch('/api/admin/combos', { id: editingId, name: editForm.name, slug: editForm.slug.trim() || undefined, enabled: editForm.enabled, ...editSettings(editForm), members: editForm.members });
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
    setForm((f) => ({ ...f, members: reindex([...f.members, { modelId, position: f.members.length, enabled: true }]) }));
  };

  const addEditMember = (modelId: string) => {
    setEditForm((f) => ({ ...f, members: reindex([...f.members, { modelId, position: f.members.length, enabled: true }]) }));
  };

  const del = async (id: string) => {
    try { await api.del(`/api/admin/combos/${id}`); toast.success('Combo removed'); setDeleting(null); void reload(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <PageHeader title="Combos" description="Virtual models combining physical models" actions={
        <Dialog open={open} onOpenChange={(next) => { if (next) setForm(emptyComboForm()); setOpen(next); }}>
          <DialogTrigger asChild><Button><Plus className="mr-1 h-4 w-4" /> New combo</Button></DialogTrigger>
          <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
            <DialogHeader><DialogTitle>New combo</DialogTitle></DialogHeader>
            <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
              <div><Label htmlFor="combo-name">Name</Label><Input id="combo-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>Slug (optional — empty uses the name as the model ID)</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="empty → gpt-5.5 · set → combo/gpt-5.5" /></div>
              <ComboKindField value={form.comboKind} onChange={(comboKind) => setForm((current) => ({ ...current, comboKind, members: [], fallbackOn429: comboKind === 'standard', slowResponseFallbackEnabled: comboKind === 'standard' }))} />
              <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><Label>Enabled</Label></div>
               <ComboSettingsFields value={form} comboKind={form.comboKind} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} hardTimeouts={form.members.filter((m) => m.enabled).map((m) => models.find((x) => x.id === m.modelId)?.providerTotalTimeoutMs ?? null)} />
              <div>
                <Label>Members — priority order · drag to reorder</Label>
                <MemberPicker key={form.comboKind} comboKind={form.comboKind} models={models} addedIds={form.members.map((m) => m.modelId)} onAdd={addMember} />
               <RoutePreview adaptive={form.slowResponseFallbackEnabled} members={form.members} modelFor={(m) => models.find((x) => x.id === m.modelId) ?? null} />
                <MemberList
                  className="mt-2"
                  members={form.members}
                  label={(m) => models.find((x) => x.id === m.modelId)?.publicModelId ?? m.modelId}
                  modelFor={(m) => models.find((x) => x.id === m.modelId) ?? null}
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
        <CardHeader><CardTitle className="text-base">All combos</CardTitle><CardDescription>{visibleCombos.length} of {combos.length} combos · sorted alphabetically</CardDescription></CardHeader>
        <CardContent>
          <div className="mb-4 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9 pr-9" placeholder="Search by combo name or model ID…" value={comboSearch} onChange={(e) => setComboSearch(e.target.value)} />
            {comboSearch && <Button type="button" size="icon" variant="ghost" className="absolute right-1 top-0.5 h-8 w-8" onClick={() => setComboSearch('')} aria-label="Clear combo search"><X className="h-4 w-4" /></Button>}
          </div>
          <Table>
            <TableHeader>
               <TableRow><TableHead>Combo</TableHead><TableHead>Members</TableHead><TableHead>Status</TableHead><TableHead>Enabled</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {visibleCombos.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{combos.length === 0 ? 'No combos yet. Create a combo to combine physical models.' : 'No combos match your search.'}</TableCell></TableRow>}
              {visibleCombos.map((c) => (
                <TableRow key={c.id}>
                  <TableCell><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{c.name}</span><Badge variant="outline">{c.comboKind === 'codex_native' ? 'Codex native' : 'Standard'}</Badge></div><div className="mt-0.5 font-mono text-xs text-muted-foreground">{c.publicModelId}</div></TableCell>
                  <TableCell>{c.memberCount}</TableCell>
                  <TableCell><Badge variant={c.status === 'ready' ? (c.comboKind === 'codex_native' ? 'outline' : 'success') : c.status === 'disabled' ? 'secondary' : 'destructive'}>{c.healthyMemberCount}/{c.memberCount} {c.comboKind === 'codex_native' ? 'eligible' : 'available'}</Badge>{c.comboKind === 'codex_native' && <div className="text-xs text-muted-foreground">Account unverified</div>}{c.slowCooldownCount > 0 && <div className="text-xs text-amber-600 dark:text-amber-400">{c.slowCooldownCount} with degraded workloads</div>}{c.slowProbeCount > 0 && <div className="text-xs text-muted-foreground">{c.slowProbeCount} recovery probe running</div>}{c.capabilityWarnings.length > 0 && <div className="text-xs text-amber-600">Capability metadata differs</div>}{c.status === 'unavailable' && c.unavailableReasons.length > 0 && <div className="text-xs text-muted-foreground">{c.unavailableReasons.map((reason) => reasonLabels[reason] ?? reason).join(', ')}</div>}</TableCell>
                  <TableCell>{c.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                       <Button size="sm" variant="outline" title={c.comboKind === 'codex_native' ? 'Test from signed-in Codex client' : 'Sends a real non-streaming inference request'} onClick={() => void testCombo(c)} disabled={testingId === c.id || c.comboKind === 'codex_native'}>
                        {testingId === c.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />} Test
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void openEdit(c)}><Edit className="h-3.5 w-3.5" /> Sửa</Button>
                       <Button size="sm" variant="destructive" onClick={() => setDeleting(c)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
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
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader><DialogTitle>Edit combo</DialogTitle></DialogHeader>
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            <div><Label htmlFor="edit-combo-name">Name</Label><Input id="edit-combo-name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div><Label>Slug (optional — leave empty to use the name as the model ID)</Label><Input value={editForm.slug} onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })} placeholder="empty → gpt-5.5 · set → combo/gpt-5.5" /></div>
            <ComboKindField value={editForm.comboKind} />
            {editForm.comboKind === 'codex_native' && <div className="rounded border p-3 text-xs text-muted-foreground">Sign in inside Codex and set a separate gateway key scoped to this combo, without token limits. In the Codex client configuration from the Providers page, replace the model value with this saved public ID: <code className="font-mono">{combos.find((c) => c.id === editingId)?.publicModelId}</code>. Test using the signed-in client.</div>}
            <div className="flex items-center gap-2"><Switch checked={editForm.enabled} onCheckedChange={(v) => setEditForm({ ...editForm, enabled: v })} /><Label>Enabled</Label></div>
               <ComboSettingsFields value={editForm} comboKind={editForm.comboKind} onChange={(patch) => setEditForm((current) => ({ ...current, ...patch }))} hardTimeouts={editForm.members.filter((m) => m.enabled).map((m) => models.find((x) => x.id === m.modelId)?.providerTotalTimeoutMs ?? null)} />
            <div>
              <Label>Members — priority order · drag to reorder</Label>
              <MemberPicker comboKind={editForm.comboKind} models={models} addedIds={editForm.members.map((m) => m.modelId)} onAdd={addEditMember} />
               <RoutePreview adaptive={editForm.slowResponseFallbackEnabled} members={editForm.members} modelFor={(m) => models.find((x) => x.id === m.modelId) ?? null} />
              <MemberList
                className="mt-2"
                members={editForm.members}
                label={(m) => models.find((x) => x.id === m.modelId)?.publicModelId ?? m.modelId}
                modelFor={(m) => models.find((x) => x.id === m.modelId) ?? null}
                onChange={(members) => setEditForm((f) => ({ ...f, members }))}
              />
              {editForm.slowResponseFallbackEnabled && <div className="rounded border bg-muted/20 p-2 text-xs">
                <div className="mb-2 flex items-center justify-between gap-2"><span className="font-medium">Adaptive routing by workload</span><Button type="button" size="sm" variant="outline" disabled={editing || !editingId} onClick={async () => {
                  if (!editingId) return;
                  try { await api.post(`/api/admin/combos/${editingId}/reset-adaptive-state`); setEditSlowStates([]); toast.success('Adaptive history reset'); void reload(); }
                  catch (e) { toast.error((e as Error).message); }
                }}>Reset history</Button></div>
                <p className="mb-2 text-muted-foreground">A degraded member remains available as a reserve. Samples and recovery are separate for each workload.</p>
                {editSlowStates.length === 0 && <p className="text-muted-foreground">No measured workload history yet. Configured priority applies while learning.</p>}
                <div className="space-y-2">
                  {editSlowStates.map((state) => {
                    const model = models.find((item) => item.id === state.modelId);
                    const now = Date.now();
                    const probing = state.probeLeaseUntilMs !== null && state.probeLeaseUntilMs > now;
                    const probeReady = state.degraded && state.probeDueMs !== null && state.probeDueMs <= now && !probing;
                    const comparator = models.find((item) => item.id === state.comparatorModelId);
                    return <div key={`${state.modelId}:${state.workload}`} className="space-y-1 rounded border bg-background p-2">
                      <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-all font-mono">{model?.publicModelId ?? state.modelId}</span>
                      {probing ? <Badge variant="secondary">Probing</Badge> : probeReady ? <Badge variant="warning">Recovery due</Badge> : state.degraded ? <Badge variant="warning">Degraded · reserve</Badge> : <Badge variant={state.state === 'ready' ? 'success' : 'outline'}>{state.state === 'ready' ? 'Ready' : state.state === 'suspect' ? 'Suspect' : 'Learning'}</Badge>}</div>
                      <div className="text-muted-foreground">{state.workload} · {state.latencyKind === 'ttft' ? 'TTFT' : 'completion'} median {state.medianLatencyMs === null ? '—' : `${Math.round(state.medianLatencyMs)} ms`} · {state.sampleCount} fresh samples</div>
                      <div className="text-muted-foreground">{state.consecutiveSlowCount} absolute slow · {state.relativeSlowCount} relative slow{state.degraded ? ` · ${state.degraded} degradation` : ''}{comparator ? ` vs ${comparator.publicModelId}` : ''}</div>
                      {state.degraded && <div className="text-muted-foreground">Recovery {state.recoverySuccesses}/2{state.probeDueMs !== null ? ` · next ${new Date(state.probeDueMs).toLocaleTimeString()}` : ''}</div>}
                      <div className="text-muted-foreground">Last update {new Date(state.updatedAtMs).toLocaleString()}</div>
                    </div>;
                  })}
                </div>
              </div>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button disabled={!editForm.name || editing} onClick={submitEdit}>{editing ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={testResult !== null} onOpenChange={(value) => { if (!value) setTestResult(null); }}>
        <DialogContent className="max-w-2xl">
           <DialogHeader><DialogTitle>Combo test result</DialogTitle><p className="text-sm text-muted-foreground">Test sends a real non-streaming inference request through this combo.</p></DialogHeader>
          {testResult && <ComboTestResultView result={testResult} />}
          <DialogFooter><Button onClick={() => setTestResult(null)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(value) => { if (!value) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete combo?</AlertDialogTitle><AlertDialogDescription>This removes the virtual model and its ordered fallback configuration. Request history is preserved.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => deleting && void del(deleting.id)}>Delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function editSettings(value: ComboSettings): ComboSettings {
  return {
    maxTotalAttempts: value.maxTotalAttempts, maxRequestDurationSeconds: value.maxRequestDurationSeconds,
    fallbackOnConnection: value.fallbackOnConnection, fallbackOnConnectTimeout: value.fallbackOnConnectTimeout,
    fallbackOnFirstTokenTimeout: value.fallbackOnFirstTokenTimeout, fallbackOnTotalTimeout: value.fallbackOnTotalTimeout,
    fallbackOn408: value.fallbackOn408, fallbackOn429: value.fallbackOn429, fallbackOn5xx: value.fallbackOn5xx,
    slowResponseFallbackEnabled: value.slowResponseFallbackEnabled, slowResponseThresholdSeconds: value.slowResponseThresholdSeconds,
    slowResponseMaxCount: value.slowResponseMaxCount,
  };
}

function ComboKindField({ value, onChange }: { value: ComboKind; onChange?: (kind: ComboKind) => void }) {
  return <div className="space-y-1">
    <Label>Combo type</Label>
    <Select value={value} disabled={!onChange} onValueChange={(kind) => onChange?.(kind as ComboKind)}>
      <SelectTrigger aria-label="Combo type"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="standard">Standard</SelectItem><SelectItem value="codex_native">Codex native</SelectItem></SelectContent>
    </Select>
    <p className="text-xs text-muted-foreground">{value === 'codex_native' ? 'Codex Responses only. Members must be Codex models with distinct upstream model IDs, available to the signed-in account.' : 'Compatible API-key and Claude Code models.'} {onChange ? 'Changing the type clears selected members. Type cannot be changed after creation.' : 'Type is locked after creation.'}</p>
  </div>;
}

function ComboSettingsFields({ value, comboKind, onChange, hardTimeouts }: { value: ComboSettings; comboKind: ComboKind; onChange: (patch: Partial<ComboSettings>) => void; hardTimeouts: Array<number | null> }) {
  const native = comboKind === 'codex_native';
  const triggers: Array<[keyof ComboSettings, string]> = [
    ['fallbackOnConnection', 'Connection failure'], ['fallbackOnConnectTimeout', 'Connect timeout'], ['fallbackOnFirstTokenTimeout', 'First-token timeout'], ['fallbackOnTotalTimeout', 'Total timeout'], ['fallbackOn408', 'HTTP 408'], ['fallbackOn429', 'HTTP 429'], ['fallbackOn5xx', 'HTTP 5xx'],
  ];
  return <div className="space-y-3 rounded border bg-muted/20 p-3">
    <div>
      <div className="mb-2 text-sm font-medium">Fallback policy</div>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="space-y-2"><div><Label>Max total attempts</Label><Input type="number" min={1} max={8} value={value.maxTotalAttempts} onChange={(e) => onChange({ maxTotalAttempts: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} /></div><div><Label>Overall deadline (seconds)</Label><Input type="number" min={1} max={3600} placeholder="No additional limit" value={value.maxRequestDurationSeconds ?? ''} onChange={(e) => onChange({ maxRequestDurationSeconds: e.target.value === '' ? null : Math.min(3600, Math.max(1, Math.round(Number(e.target.value) || 1))) })} /></div></div>
        <div className="grid gap-2 sm:grid-cols-2">{triggers.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><Switch aria-label={label} disabled={native && key === 'fallbackOn429'} checked={Boolean(value[key])} onCheckedChange={(checked) => onChange({ [key]: checked })} /><span>{label}</span></label>)}</div>
      </div>
    </div>
    <div className="border-t pt-3">
      <label className="mb-2 flex items-center gap-2 text-sm font-medium"><Switch aria-label="Adaptive fallback and recovery" disabled={native} checked={value.slowResponseFallbackEnabled} onCheckedChange={(checked) => onChange({ slowResponseFallbackEnabled: checked })} />Adaptive fallback and recovery</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label>Response threshold (seconds)</Label><Input type="number" min={1} max={600} disabled={!value.slowResponseFallbackEnabled} value={value.slowResponseThresholdSeconds} onChange={(e) => onChange({ slowResponseThresholdSeconds: Math.min(600, Math.max(1, Math.round(Number(e.target.value) || 1))) })} /></div>
        <div><Label>Slow responses before demotion</Label><Input type="number" min={1} max={20} disabled={!value.slowResponseFallbackEnabled} value={value.slowResponseMaxCount} onChange={(e) => onChange({ slowResponseMaxCount: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))) })} /></div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{native ? 'Codex native combos follow configured priority. Adaptive recovery and fallback on HTTP 429 are unavailable. All members use the same signed-in client credential.' : 'Streaming measures the first deliverable generated token, including supported reasoning; non-streaming measures full completion. Similar speeds preserve configured priority. Repeated slowness demotes a model to reserve; recovery probes can restore its priority. The final viable candidate may exceed the soft threshold, but hard timeouts always apply.'}</p>
      {value.slowResponseFallbackEnabled && value.maxTotalAttempts < 3 && <p className="text-xs text-amber-600 dark:text-amber-400">A rescue replay may need 3 attempts. The configured cap is always enforced.</p>}
      {value.slowResponseFallbackEnabled && value.maxRequestDurationSeconds !== null && value.maxRequestDurationSeconds <= value.slowResponseThresholdSeconds && <p className="text-xs text-amber-600 dark:text-amber-400">The overall deadline may expire before a slow-response fallback can occur.</p>}
      {value.slowResponseFallbackEnabled && hardTimeouts.some((ms) => ms !== null && ms <= value.slowResponseThresholdSeconds * 1000) && <p className="text-xs text-amber-600 dark:text-amber-400">At least one provider has a hard total timeout at or below the soft threshold. Its hard timeout takes precedence.</p>}
    </div>
  </div>;
}

function RoutePreview({ members, modelFor, adaptive }: { members: MemberForm[]; modelFor: (member: MemberForm) => ModelRow | null; adaptive: boolean }) {
  if (members.length === 0) return null;
  const selected = members.map(modelFor).filter((model): model is ModelRow => Boolean(model));
  const capabilityWarnings = ['chat', 'streaming', 'tools', 'structured_output', 'image_input', 'reasoning'].filter((key) => new Set(selected.map((model) => model.capabilities[key] === true ? 'yes' : model.capabilities[key] === false ? 'no' : 'unknown')).size > 1);
  return (
    <div className="rounded border bg-muted/20 p-2 text-xs">
      <div className="mb-1 font-medium">Configured priority {adaptive && <span className="font-normal text-muted-foreground">(adaptive routing may temporarily demote a member)</span>}</div>
      {capabilityWarnings.length > 0 && <div className="mb-2 flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3.5 w-3.5" /> Members differ on: {capabilityWarnings.join(', ')}</div>}
      <div className="space-y-1">
        {members.map((member, index) => {
          const model = modelFor(member);
          return (
            <div key={member.id ?? member.modelId} className="flex items-center gap-2 font-mono">
              <span className="w-4 text-muted-foreground">{index + 1}.</span>
              <span>{model?.publicModelId ?? member.modelId}</span>
              <span className="text-muted-foreground">→ {model?.upstreamModelId ?? "upstream model unknown"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ComboTestResultView({ result }: { result: ComboTestResult }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded border p-3">
        <div className="flex items-center gap-2">
          {result.success ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
          <Badge variant={result.success ? "success" : "warning"}>{result.success ? "Success" : "Failed"}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">{result.latencyMs} ms total</span>
      </div>
      <div>
        <div className="mb-1 text-sm font-medium">Selected upstream</div>
        {result.selectedModel ? (
          <div className="rounded border bg-muted/20 p-2 font-mono text-xs">
            {result.selectedModel.publicModelId} → {result.selectedModel.upstreamModelId}
            <span className="ml-2 text-muted-foreground">({result.selectedModel.providerSlug})</span>
          </div>
        ) : <p className="text-sm text-muted-foreground">No member completed successfully.</p>}
      </div>
      <div>
        <div className="mb-1 text-sm font-medium">Attempts</div>
        <div className="space-y-1">
          {result.attempts.map((attempt, index) => (
            <div key={attempt.publicModelId + "-" + index} className="flex items-center gap-2 rounded border p-2 text-xs">
              <span className="w-4 text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 flex-1 font-mono">{attempt.publicModelId} → {attempt.upstreamModelId}<span className="block font-sans text-muted-foreground">{attempt.selectionReason.replaceAll('_', ' ')}</span></span>
              <span className="text-muted-foreground">{attempt.latencyMs} ms</span>
              <Badge variant={attempt.success ? "success" : "warning"}>{attempt.success ? "Used" : attempt.failureReason ?? "Skipped"}</Badge>
            </div>
          ))}
        </div>
      </div>
      {result.text && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 text-xs">{result.text}</pre>}
    </div>
  );
}

// Drag-sortable member rows: the row order IS the routing priority that gets saved
// as member.position (0 = highest priority).
function MemberList({ members, label, modelFor, onChange, className }: {
  members: MemberForm[];
  label: (member: MemberForm) => string;
  modelFor: (member: MemberForm) => ModelRow | null;
  onChange: (members: MemberForm[]) => void;
  className?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (members.length === 0) return <p className={cn('text-xs text-muted-foreground', className)}>No members yet — add at least one.</p>;
  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || from >= members.length || to >= members.length || from === to) return;
    onChange(reindex(arrayMove(members, from, to)));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(members.findIndex((m) => m.modelId === active.id), members.findIndex((m) => m.modelId === over.id));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
      <SortableContext items={members.map((m) => m.modelId)} strategy={verticalListSortingStrategy}>
        <div className={cn('space-y-1', className)}>
          {members.map((m, i) => (
            <MemberRow
              key={m.modelId}
              modelId={m.modelId}
              index={i}
              label={label(m)}
              model={modelFor(m)}
              enabled={m.enabled}
              onMoveUp={i > 0 ? () => move(i, i - 1) : undefined}
              onMoveDown={i < members.length - 1 ? () => move(i, i + 1) : undefined}
              onToggle={(enabled) => onChange(members.map((member, j) => j === i ? { ...member, enabled } : member))}
              onRemove={() => onChange(reindex(members.filter((_, j) => j !== i)))}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** One member row. Separate because useSortable is a hook and must run per row. */
function MemberRow({ modelId, index, label, model, enabled, onMoveUp, onMoveDown, onToggle, onRemove }: {
  modelId: string;
  index: number;
  label: string;
  model: ModelRow | null;
  enabled: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: modelId });
  const native = model?.providerKind === 'codex';
  const available = enabled && !!model && model.enabled && model.providerEnabled && !model.circuitOpen && model.upstreamAvailable && (native ? model.capabilities.responses !== false : model.capabilities.chat !== false);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn('flex items-center gap-2 rounded border p-2 text-sm', isDragging && 'relative z-10 bg-muted/60 shadow-sm')}
    >
      <button
        ref={setActivatorNodeRef}
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
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs">{label}</div>
        <div className="truncate text-[11px] text-muted-foreground">{model?.providerSlug || "provider"} · upstream: {model?.upstreamModelId ?? "unknown"}</div>
      </div>
      <Badge variant={available && !native ? 'success' : 'secondary'}>{!enabled ? 'Disabled' : available ? (native ? 'Account unverified' : model?.providerHealth === 'down' || model?.providerHealth === 'degraded' ? 'Ready · degraded provider' : 'Ready') : 'Unavailable'}</Badge>
      <div className="flex shrink-0 flex-col gap-0.5">
        <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={`Move ${label} up`} title="Move up" disabled={!onMoveUp} onClick={onMoveUp}><ChevronUp /></Button>
        <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={`Move ${label} down`} title="Move down" disabled={!onMoveDown} onClick={onMoveDown}><ChevronDown /></Button>
      </div>
      <Switch aria-label={`Enable ${label}`} checked={enabled} onCheckedChange={onToggle} />
      <Button size="sm" variant="outline" onClick={onRemove}>Remove</Button>
    </div>
  );
}

// Searchable model picker used to add members to a combo (create + edit).
function MemberPicker({ models, addedIds, onAdd, comboKind }: { models: ModelRow[]; addedIds: string[]; onAdd: (modelId: string) => void; comboKind: ComboKind }) {
  const [q, setQ] = useState('');
  const filtered = q
    ? models.filter((m) => {
      const s = q.toLowerCase();
      return m.publicModelId.toLowerCase().includes(s) || m.displayName.toLowerCase().includes(s);
    })
    : models;
  const native = comboKind === 'codex_native';
  const addedUpstreamIds = new Set(models.filter((m) => addedIds.includes(m.id)).map((m) => m.upstreamModelId));
  const available = filtered.filter((m) => (m.providerKind === 'codex') === native && !addedIds.includes(m.id) && (!native || !addedUpstreamIds.has(m.upstreamModelId)));
  return (
    <div className="space-y-1">
      {native && <p className="text-xs text-muted-foreground">One member per upstream model ID. Duplicate IDs are excluded after selection.</p>}
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
              <Button size="sm" variant="ghost" aria-label={`Add ${m.publicModelId}`} onClick={() => onAdd(m.id)}>+ Add</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
