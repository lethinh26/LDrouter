// Alias management: stable client-facing model IDs with searchable destinations.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Boxes, CheckCircle2, Copy, Edit2, Layers, Link2, Plus, Search, Trash2, X } from 'lucide-react';

type TargetKind = 'model' | 'combo';
interface Alias { id: string; alias: string; targetKind: TargetKind; targetId: string; targetName?: string | null; enabled: boolean; }
interface Model { id: string; publicModelId: string; }
interface Combo { id: string; publicModelId: string; }
interface AliasForm { alias: string; targetKind: TargetKind; targetId: string; enabled: boolean; }

const EMPTY_FORM: AliasForm = { alias: '', targetKind: 'model', targetId: '', enabled: true };
const compareAlphabetically = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Keep the preview in sync with the server's slugify() implementation.
function slugifyAlias(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
}

export function Aliases() {
  const [rows, setRows] = useState<Alias[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editingAlias, setEditingAlias] = useState<Alias | null>(null);
  const [form, setForm] = useState<AliasForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [deletingAlias, setDeletingAlias] = useState<Alias | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const reload = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [a, m, c] = await Promise.all([
        api.get<{ aliases: Alias[] }>('/api/admin/aliases'),
        api.get<{ models: Model[] }>('/api/admin/models'),
        api.get<{ combos: Combo[] }>('/api/admin/combos'),
      ]);
      setRows(a.aliases);
      setModels(m.models);
      setCombos(c.combos);
    } catch (e) {
      const message = (e as Error).message || 'Unable to load aliases';
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);

  const aliasPreview = slugifyAlias(form.alias);
  const duplicateAlias = rows.some((row) => row.alias === aliasPreview && row.id !== editingAlias?.id);
  const shadowedTarget = models.some((model) => model.publicModelId === aliasPreview)
    || combos.some((combo) => combo.publicModelId === aliasPreview);
  const aliasError = !form.alias.trim()
    ? 'Enter a client-facing alias.'
    : duplicateAlias
      ? 'This alias is already in use.'
      : shadowedTarget
        ? 'This name is already a model or combo ID.'
        : null;
  const targetOptions = (form.targetKind === 'model' ? models : combos)
    .slice()
    .sort((a, b) => compareAlphabetically(a.publicModelId, b.publicModelId));
  const formValid = Boolean(form.alias.trim() && form.targetId && !aliasError);

  const filteredRows = rows
    .filter((row) => {
      if (kindFilter !== 'all' && row.targetKind !== kindFilter) return false;
      if (statusFilter === 'enabled' && !row.enabled) return false;
      if (statusFilter === 'disabled' && row.enabled) return false;
      const query = search.trim().toLowerCase();
      return !query || [row.alias, row.targetName, row.targetId].some((value) => value?.toLowerCase().includes(query));
    })
    .sort((a, b) => compareAlphabetically(a.alias, b.alias));

  const openCreate = () => {
    setEditingAlias(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  };

  const openEdit = (alias: Alias) => {
    setEditingAlias(alias);
    setForm({ alias: alias.alias, targetKind: alias.targetKind, targetId: alias.targetId, enabled: alias.enabled });
    setOpen(true);
  };

  const closeForm = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setEditingAlias(null);
      setForm(EMPTY_FORM);
    }
  };

  const submit = async () => {
    if (!formValid) return;
    setSaving(true);
    try {
      const payload = { alias: form.alias.trim(), targetKind: form.targetKind, targetId: form.targetId, enabled: form.enabled };
      if (editingAlias) {
        await api.patch('/api/admin/aliases', { id: editingAlias.id, ...payload });
        toast.success('Alias updated');
      } else {
        await api.post('/api/admin/aliases', payload);
        toast.success('Alias created');
      }
      closeForm(false);
      await reload();
    } catch (e) {
      toast.error((e as Error).message || 'Unable to save alias');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (alias: Alias, enabled: boolean) => {
    setUpdatingId(alias.id);
    try {
      await api.patch('/api/admin/aliases', { id: alias.id, enabled });
      setRows((current) => current.map((row) => row.id === alias.id ? { ...row, enabled } : row));
      toast.success(enabled ? 'Alias enabled' : 'Alias disabled');
    } catch (e) {
      toast.error((e as Error).message || 'Unable to update alias');
    } finally {
      setUpdatingId(null);
    }
  };

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Clipboard access is unavailable in this browser');
    }
  };

  const confirmDelete = async () => {
    if (!deletingAlias) return;
    setDeleting(true);
    try {
      await api.del(`/api/admin/aliases/${deletingAlias.id}`);
      toast.success('Alias deleted');
      setDeletingAlias(null);
      await reload();
    } catch (e) {
      toast.error((e as Error).message || 'Unable to delete alias');
    } finally {
      setDeleting(false);
    }
  };

  const enabledCount = rows.filter((row) => row.enabled).length;
  const modelAliasCount = rows.filter((row) => row.targetKind === 'model').length;
  const comboAliasCount = rows.filter((row) => row.targetKind === 'combo').length;

  return (
    <div className="space-y-6">
      <PageHeader title="Aliases" description="Stable client-facing model names that point to a physical model or combo" actions={
        <Button onClick={openCreate}><Plus className="mr-1 h-4 w-4" /> New alias</Button>
      } />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Total aliases', value: rows.length, detail: 'Client-facing names', icon: Link2 },
          { label: 'Enabled', value: enabledCount, detail: 'Alias switch is on', icon: CheckCircle2 },
          { label: 'Physical models', value: modelAliasCount, detail: 'Aliases to provider models', icon: Boxes },
          { label: 'Combos', value: comboAliasCount, detail: 'Aliases to virtual models', icon: Layers },
        ].map((stat) => {
          const Icon = stat.icon;
          return <Card key={stat.label}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{stat.value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{stat.detail}</p>
              </div>
              <div className="rounded-lg bg-muted p-2.5"><Icon className="h-5 w-5 text-muted-foreground" /></div>
            </CardContent>
          </Card>;
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alias directory</CardTitle>
          <CardDescription>{filteredRows.length} of {rows.length} aliases · sorted A–Z</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9 pr-9" placeholder="Search alias or destination…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <Button type="button" size="icon" variant="ghost" className="absolute right-1 top-0.5 h-8 w-8" onClick={() => setSearch('')} aria-label="Clear alias search"><X className="h-4 w-4" /></Button>}
            </div>
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger className="w-full lg:w-44"><SelectValue placeholder="All destinations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All destinations</SelectItem>
                <SelectItem value="model">Physical models</SelectItem>
                <SelectItem value="combo">Combos</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full lg:w-40"><SelectValue placeholder="All statuses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="enabled">Enabled</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {loadError && <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{loadError}</span>
            <Button size="sm" variant="outline" onClick={() => void reload()}>Try again</Button>
          </div>}

          {loading && rows.length === 0 ? <div className="space-y-2">
            <div className="h-12 animate-pulse rounded-md bg-muted" />
            <div className="h-12 animate-pulse rounded-md bg-muted" />
            <div className="h-12 animate-pulse rounded-md bg-muted" />
          </div> : filteredRows.length === 0 ? <div className="rounded-lg border border-dashed px-4 py-10 text-center">
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-muted"><Link2 className="h-5 w-5 text-muted-foreground" /></div>
            <p className="font-medium">{rows.length === 0 ? 'No aliases yet' : 'No matching aliases'}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{rows.length === 0
              ? 'Create a stable model name that your applications can keep using while you change its destination later.'
              : 'Try a different search term or clear the filters to see all aliases.'}</p>
            {rows.length === 0
              ? <Button className="mt-4" onClick={openCreate}><Plus className="mr-1 h-4 w-4" /> Create your first alias</Button>
              : <Button className="mt-4" variant="outline" onClick={() => { setSearch(''); setKindFilter('all'); setStatusFilter('all'); }}>Clear filters</Button>}
          </div> : <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client model ID</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((alias) => (
                <TableRow key={alias.id}>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2">
                      <code className="truncate text-sm font-medium">{alias.alias}</code>
                      <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0" title="Copy alias" aria-label={`Copy alias ${alias.alias}`} onClick={() => void copyValue(alias.alias, 'Alias')}><Copy className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2">
                      <Link to={alias.targetKind === 'model' ? '/models' : '/combos'} className="truncate font-mono text-xs text-primary hover:underline">{alias.targetName ?? 'Target unavailable'}</Link>
                      {alias.targetName && <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0" title="Copy destination ID" aria-label={`Copy destination ${alias.targetName}`} onClick={() => void copyValue(alias.targetName!, 'Destination ID')}><Copy className="h-3.5 w-3.5" /></Button>}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline">{alias.targetKind === 'model' ? 'Physical model' : 'Combo'}</Badge></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch checked={alias.enabled} onCheckedChange={(checked) => void toggleEnabled(alias, checked)} disabled={updatingId === alias.id} aria-label={`${alias.enabled ? 'Disable' : 'Enable'} alias ${alias.alias}`} />
                      <span className="text-xs text-muted-foreground">{updatingId === alias.id ? 'Saving…' : alias.enabled ? 'Enabled' : 'Disabled'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button type="button" size="icon" variant="ghost" title="Edit alias" aria-label={`Edit alias ${alias.alias}`} onClick={() => openEdit(alias)}><Edit2 className="h-4 w-4" /></Button>
                      <Button type="button" size="icon" variant="ghost" title="Delete alias" aria-label={`Delete alias ${alias.alias}`} onClick={() => setDeletingAlias(alias)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={closeForm}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingAlias ? 'Edit alias' : 'Create an alias'}</DialogTitle>
            <DialogDescription>Give applications a stable model ID and choose the physical model or combo that receives requests.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="alias-name">Client-facing alias</Label>
              <Input id="alias-name" value={form.alias} maxLength={64} onChange={(e) => setForm((current) => ({ ...current, alias: e.target.value }))} placeholder="e.g. coding, fast, production" aria-invalid={Boolean(aliasError)} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className={aliasError ? 'text-destructive' : 'text-muted-foreground'}>{aliasError ?? 'Letters and numbers are kept; spaces become hyphens.'}</span>
                <span className="text-muted-foreground">{form.alias.length}/64</span>
              </div>
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">Client model ID preview</p>
                <code className="mt-1 block text-sm font-medium">{form.alias.trim() ? aliasPreview : 'your-alias'}</code>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Destination type</Label>
                <Select value={form.targetKind} onValueChange={(value) => setForm((current) => ({ ...current, targetKind: value as TargetKind, targetId: '' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="model">Physical model</SelectItem><SelectItem value="combo">Combo</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Destination</Label>
                <Select value={form.targetId} onValueChange={(value) => setForm((current) => ({ ...current, targetId: value }))}>
                  <SelectTrigger><SelectValue placeholder="Choose a destination" /></SelectTrigger>
                  <SelectContent>
                    {targetOptions.map((target) => <SelectItem key={target.id} value={target.id}>{target.publicModelId}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{targetOptions.length} {form.targetKind === 'model' ? 'physical models' : 'combos'} available</p>
              </div>
            </div>

            {targetOptions.length === 0 && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No {form.targetKind === 'model' ? 'physical models' : 'combos'} are available yet. Add one before creating this alias.</p>}

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="alias-enabled">Alias enabled</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Disabled aliases are hidden from API model listings and cannot be resolved.</p>
              </div>
              <Switch id="alias-enabled" checked={form.enabled} onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => closeForm(false)}>Cancel</Button>
            <Button type="button" disabled={!formValid || saving} onClick={() => void submit()}>{saving ? 'Saving…' : editingAlias ? 'Save changes' : 'Create alias'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deletingAlias !== null} onOpenChange={(value) => { if (!value && !deleting) setDeletingAlias(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete alias?</AlertDialogTitle>
            <AlertDialogDescription>Applications using <code>{deletingAlias?.alias}</code> will no longer be able to resolve this model ID. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={deleting} onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>{deleting ? 'Deleting…' : 'Delete alias'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
