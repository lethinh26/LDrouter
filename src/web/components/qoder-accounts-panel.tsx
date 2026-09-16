// Qoder account pool panel: PAT accounts, health, job-token expiry, catalog refresh, and
// drag-and-drop routing order. Simpler than the Codex panel because Qoder exposes no quota API —
// the only upstream truth is the model catalog.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, GripVertical, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { QoderImportDialog } from './qoder-import-dialog';

export interface QoderAccount {
  id: string; label: string | null; email: string | null; qoderUserIdMasked: string | null;
  enabled: boolean; healthState: string; priority: number; jobTokenExpiresAt: string;
  catalogFetchedAt: string | null; lastError: string | null; consecutiveFailures: number;
  createdAt: string; updatedAt: string;
}

const PAGE_SIZES = ['10', '25', '50'];

function countdown(at: string | null, now: number): string {
  if (!at) return '—';
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function healthBadge(state: string) {
  const variant = state === 'healthy' ? 'default' : state === 'degraded' ? 'secondary' : state === 'down' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{state}</Badge>;
}

export function QoderAccountsPanel({ providerId, providerName }: { providerId: string; providerName?: string }) {
  const [accounts, setAccounts] = useState<QoderAccount[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('10');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ accounts: QoderAccount[] }>(`/api/admin/qoder/accounts?providerId=${encodeURIComponent(providerId)}`);
      setAccounts(result.accounts);
    } catch (e) { toast.error((e as Error).message || 'Unable to load Qoder accounts'); }
    finally { setLoading(false); }
  }, [providerId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (account: QoderAccount, message: string, run: () => Promise<unknown>) => {
    setBusyId(account.id);
    try { await run(); toast.success(`${message}: ${account.label || account.qoderUserIdMasked || account.id}`); }
    catch (e) { toast.error((e as Error).message || `${message} failed`); }
    finally { setBusyId(null); }
  };

  const addToken = async () => {
    setAdding(true); setAddError('');
    try {
      const result = await api.post<{ account: QoderAccount; catalogError: string | null }>('/api/admin/qoder/accounts', { providerId, personalToken: token, label: label.trim() || undefined });
      toast.success(result.catalogError ? 'Account added, but the model catalog could not be fetched' : 'Account added');
      setAddOpen(false); setToken(''); setLabel('');
      await load();
    } catch (e) { setAddError((e as Error).message || 'Unable to add the token'); }
    finally { setAdding(false); }
  };

  const filtered = accounts.filter((account) => {
    if (!search) return true;
    const needle = search.toLowerCase();
    return [account.label, account.email, account.qoderUserIdMasked].some((value) => value?.toLowerCase().includes(needle));
  });
  const size = Number(pageSize);
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * size, current * size);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Reorder the full list, not the visible slice, so paging never reshuffles hidden accounts.
  const reorder = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = accounts.findIndex((account) => account.id === active.id);
    const to = accounts.findIndex((account) => account.id === over.id);
    if (from < 0 || to < 0) return;
    const previous = accounts;
    const next = arrayMove(accounts, from, to);
    setAccounts(next);
    try {
      await api.post('/api/admin/qoder/accounts/reorder', { providerId, ids: next.map((account) => account.id) });
      toast.success('Routing order updated');
    } catch (e) { setAccounts(previous); toast.error((e as Error).message || 'Unable to save the routing order'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Qoder accounts</h3>
          <p className="text-xs text-muted-foreground">{accounts.length} account{accounts.length === 1 ? '' : 's'} · drag a row to set routing order · each account is one personal access token</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 w-40" placeholder="Filter accounts…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <Button size="sm" variant="outline" disabled={busyId !== null || accounts.length === 0} onClick={() => void (async () => {
            setBusyId('all');
            try { await Promise.allSettled(accounts.map((account) => api.post(`/api/admin/qoder/accounts/${account.id}/catalog`))); await load(); toast.success('Model catalogs refreshed'); }
            finally { setBusyId(null); }
          })()}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh catalogs
          </Button>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}><Upload className="mr-1 h-4 w-4" /> Import tokens</Button>
          <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="mr-1 h-4 w-4" /> Add token</Button>
        </div>
      </div>

      {loading ? <p className="py-3 text-sm text-muted-foreground">Loading Qoder accounts…</p>
        : accounts.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No Qoder accounts yet. Add a personal access token or import a list.</p>
        : filtered.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No account matches “{search}”.</p>
        : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorder(event)} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="text-xs">Account</TableHead>
                    <TableHead className="text-xs">User</TableHead>
                    <TableHead className="text-xs">Job token</TableHead>
                    <TableHead className="text-xs">Catalog</TableHead>
                    <TableHead className="text-xs">Health</TableHead>
                    <TableHead className="text-xs">Enabled</TableHead>
                    <TableHead className="text-right text-xs">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <SortableContext items={visible.map((account) => account.id)} strategy={verticalListSortingStrategy}>
                  <TableBody>
                    {visible.map((account) => (
                      <SortableAccountRow
                        key={account.id}
                        account={account}
                        now={now}
                        busy={busyId === account.id}
                        onToggle={(enabled) => void act(account, enabled ? 'Enabled' : 'Disabled', () => api.patch(`/api/admin/qoder/accounts/${account.id}`, { enabled })).then(() => load())}
                        onDelete={() => void act(account, 'Deleted', () => api.del(`/api/admin/qoder/accounts/${account.id}`)).then(() => load())}
                        onChanged={() => void load()}
                      />
                    ))}
                  </TableBody>
                </SortableContext>
              </Table>
            </DndContext>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>Rows per page</span>
              <Select value={pageSize} onValueChange={(value) => { setPageSize(value); setPage(1); }}>
                <SelectTrigger className="h-7 w-16"><SelectValue /></SelectTrigger>
                <SelectContent>{PAGE_SIZES.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span>Page {current} of {pages}</span>
              <Button size="sm" variant="outline" aria-label="Previous page" disabled={current <= 1} onClick={() => setPage(current - 1)}><ChevronLeft className="h-3 w-3" /></Button>
              <Button size="sm" variant="outline" aria-label="Next page" disabled={current >= pages} onClick={() => setPage(current + 1)}><ChevronRight className="h-3 w-3" /></Button>
            </div>
          </div>
        </>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a Qoder token</DialogTitle>
            <DialogDescription>Paste a personal access token for {providerName || 'this provider'}. It is exchanged immediately and stored encrypted.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div><Label htmlFor="qoder-token">Personal access token</Label><Input id="qoder-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="pt-…" className="font-mono" /></div>
            <div><Label htmlFor="qoder-label">Label (optional)</Label><Input id="qoder-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work account" /></div>
            {addError && <p role="alert" className="text-sm text-destructive">{addError}</p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button><Button disabled={adding || !token.trim()} onClick={() => void addToken()}>{adding ? 'Verifying…' : 'Add token'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {importOpen && <QoderImportDialog providerId={providerId} open onOpenChange={(open) => { if (!open) setImportOpen(false); }} onImported={() => void load()} />}
    </div>
  );
}

interface RowProps {
  account: QoderAccount;
  now: number;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  /** Re-read the account list: Test/Catalog change server-side fields this row renders. */
  onChanged: () => void;
}

/** One account row. Separate because useSortable is a hook and must run per row. */
function SortableAccountRow({ account, now, busy, onToggle, onDelete, onChanged }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.id, disabled: busy });
  const label = account.label || account.email || account.qoderUserIdMasked || account.id;

  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn(account.enabled ? undefined : 'opacity-60', isDragging && 'relative z-10 bg-muted/60 shadow-sm')}
    >
      <TableCell className="w-8 pr-0">
        <button className="cursor-grab text-muted-foreground disabled:cursor-not-allowed" aria-label={`Reorder ${label}`} disabled={busy} {...attributes} {...listeners}><GripVertical className="h-4 w-4" /></button>
      </TableCell>
      <TableCell>
        <div className="text-sm">{label}</div>
        {account.email && account.label && <div className="text-xs text-muted-foreground">{account.email}</div>}
        {account.lastError && <div className="text-xs text-destructive">{account.lastError}</div>}
      </TableCell>
      <TableCell className="font-mono text-xs">{account.qoderUserIdMasked || '—'}</TableCell>
      <TableCell className="text-xs tabular-nums">{countdown(account.jobTokenExpiresAt, now)}</TableCell>
      <TableCell className="text-xs tabular-nums">{account.catalogFetchedAt ? `${countdown(account.catalogFetchedAt, now)} ago` : 'never'}</TableCell>
      <TableCell>{healthBadge(account.healthState)}</TableCell>
      <TableCell>
        <Button size="sm" variant={account.enabled ? 'secondary' : 'outline'} disabled={busy} onClick={() => onToggle(!account.enabled)}>
          {account.enabled ? 'Enabled' : 'Disabled'}
        </Button>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void (async () => {
            try { const r = await api.post<{ ok: boolean; detail: string; modelCount: number | null }>(`/api/admin/qoder/accounts/${account.id}/test`); toast[r.ok ? 'success' : 'error'](`${label}: ${r.detail}${r.modelCount === null ? '' : ` (${r.modelCount} models)`}`); onChanged(); }
            catch (e) { toast.error((e as Error).message || 'Test failed'); }
          })()}>Test</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void (async () => {
            try { const r = await api.post<{ modelCount: number }>(`/api/admin/qoder/accounts/${account.id}/catalog`); toast.success(`${label}: ${r.modelCount} models`); onChanged(); }
            catch (e) { toast.error((e as Error).message || 'Catalog refresh failed'); }
          })()}>Catalog</Button>
          <Button size="sm" variant="ghost" aria-label={`Delete ${label}`} disabled={busy} onClick={() => { if (window.confirm(`Delete the Qoder account ${label}? The stored token is removed permanently.`)) onDelete(); }}><Trash2 className="h-3 w-3" /></Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
