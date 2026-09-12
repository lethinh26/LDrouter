// Codex account pool panel: quota bars, usage refresh, weekly quota reset, 5-hour
// window auto-start, and drag-and-drop routing order. Rendered per Codex provider.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, GripVertical, Link2, RefreshCw, RotateCcw, Settings2, Trash2, Upload } from 'lucide-react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { CodexImportDialog } from './codex-import-dialog';
import { CodexOAuthDialog } from './codex-oauth-dialog';

interface Quota { used: number; total: number; remaining: number; resetAt: string | null }
interface Usage { quotas: Record<string, Quota>; plan: string; limitReached: boolean; resetCredits: number; fetchedAt: string; unavailable?: string }
export interface CodexAccount {
  id: string; email: string | null; accountIdMasked: string | null; workspaceIdMasked: string | null; planType: string | null;
  tokenExpiresAt: string; enabled: boolean; healthState: string; lastRefreshAt: string | null; priority: number;
  autostart: boolean; usage: Usage | null; usageError: string | null; usageUpdatedAt: string | null;
  lastPingedResetAt: string | null; lastPingAt: string | null;
}

const PAGE_SIZES = ['10', '25', '50'];

function countdown(resetAt: string | null, now: number): string {
  if (!resetAt) return '—';
  const ms = Date.parse(resetAt) - now;
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'reset ready';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours < 24 ? `${hours}h ${rest}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function windowCell(quota: Quota | undefined, now: number, label: string) {
  if (!quota) return <span className="text-xs text-muted-foreground">—</span>;
  const exhausted = quota.remaining <= 0;
  return (
    <div className="min-w-[9rem] space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={exhausted ? 'font-medium text-destructive' : 'text-muted-foreground'}>{label} {Math.round(quota.remaining)}% left</span>
        <span className="tabular-nums text-muted-foreground">{countdown(quota.resetAt, now)}</span>
      </div>
      <Progress value={quota.used} indicatorClassName={exhausted ? 'bg-destructive' : quota.remaining < 30 ? 'bg-amber-500' : 'bg-emerald-500'} />
    </div>
  );
}

export function CodexUsagePanel({ providerId, providerName }: { providerId: string; providerName?: string }) {
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('10');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // Keep window countdowns honest without re-fetching the API.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ accounts: CodexAccount[] }>(`/api/admin/codex/accounts?providerId=${encodeURIComponent(providerId)}`);
      setAccounts(result.accounts);
    } catch (e) { toast.error((e as Error).message || 'Unable to load Codex accounts'); }
    finally { setLoading(false); }
  }, [providerId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (account: CodexAccount, label: string, run: () => Promise<unknown>) => {
    setBusyId(account.id);
    try { await run(); toast.success(`${label}: ${account.email || account.accountIdMasked || account.id}`); }
    catch (e) { toast.error((e as Error).message || `${label} failed`); }
    finally { setBusyId(null); }
  };
  const applyAccount = (id: string, account: CodexAccount) => setAccounts((list) => list.map((row) => (row.id === id ? account : row)));
  const patchAccount = (id: string, changes: Record<string, unknown>) => act(accounts.find((a) => a.id === id)!, 'Updated', async () => {
    applyAccount(id, (await api.patch<{ account: CodexAccount }>(`/api/admin/codex/accounts/${id}`, changes)).account);
  });

  const filtered = accounts.filter((account) => {
    if (!search) return true;
    const needle = search.toLowerCase();
    return [account.email, account.accountIdMasked, account.workspaceIdMasked, account.planType].some((value) => value?.toLowerCase().includes(needle));
  });
  const size = Number(pageSize);
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * size, current * size);
  const refreshAll = async () => {
    setBusyId('all');
    try {
      await Promise.allSettled(accounts.map((account) => api.post(`/api/admin/codex/accounts/${account.id}/usage`)));
      await load();
      toast.success('Usage refreshed for all accounts');
    } finally { setBusyId(null); }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Reorder in the full list, not the visible slice, so filtering or paging never reshuffles
  // accounts the operator cannot see. Persisted order is priority 0..n-1.
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
      await api.post('/api/admin/codex/accounts/reorder', { providerId, ids: next.map((account) => account.id) });
      toast.success('Routing order updated');
    } catch (e) { setAccounts(previous); toast.error((e as Error).message || 'Unable to save the routing order'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Codex accounts</h3>
          <p className="text-xs text-muted-foreground">{accounts.length} account{accounts.length === 1 ? '' : 's'} · drag a row to set routing order · quotas come from the ChatGPT usage API</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 w-40" placeholder="Filter accounts…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <Button size="sm" variant="outline" disabled={busyId !== null || accounts.length === 0} onClick={() => void refreshAll()}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh all
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOauthOpen(true)}><Link2 className="mr-1 h-4 w-4" /> Connect Codex</Button>
          <Button size="sm" onClick={() => setImportOpen(true)}><Upload className="mr-1 h-4 w-4" /> Import accounts</Button>
        </div>
      </div>

      {loading ? <p className="py-3 text-sm text-muted-foreground">Loading Codex accounts…</p>
        : accounts.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No Codex accounts yet. Use Connect Codex to authorize one, or import existing account JSON.</p>
        : filtered.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No account matches “{search}”.</p>
        : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <TooltipProvider delayDuration={200}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorder(event)} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="text-xs">Account</TableHead>
                    <TableHead className="text-xs">Plan</TableHead>
                    <TableHead className="text-xs">5h window</TableHead>
                    <TableHead className="text-xs">Weekly</TableHead>
                    <TableHead className="text-xs">Reset credits</TableHead>
                    <TableHead className="text-xs">Auto-start 5h</TableHead>
                    <TableHead className="text-xs">Token expiry</TableHead>
                    <TableHead className="text-xs">Health</TableHead>
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
                        onPatch={(changes) => void patchAccount(account.id, changes)}
                        onUsage={(result) => applyAccount(account.id, result)}
                        onDelete={() => void act(account, 'Deleted', () => api.del(`/api/admin/codex/accounts/${account.id}`)).then(() => load())}
                      />
                    ))}
                  </TableBody>
                </SortableContext>
              </Table>
            </DndContext>
            </TooltipProvider>
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

      {importOpen && <CodexImportDialog providerId={providerId} open onOpenChange={(open) => { if (!open) setImportOpen(false); }} onImported={() => void load()} />}
      {oauthOpen && (
        <CodexOAuthDialog
          providerId={providerId}
          providerName={providerName || 'this Codex provider'}
          open
          onOpenChange={(open) => { if (!open) setOauthOpen(false); }}
          onConnected={() => void load()}
        />
      )}
    </div>
  );
}

interface SortableRowProps {
  account: CodexAccount;
  now: number;
  busy: boolean;
  onPatch: (changes: Record<string, unknown>) => void;
  onUsage: (account: CodexAccount) => void;
  onDelete: () => void;
}

/** One account row. Kept separate because useSortable is a hook and must run per row. */
function SortableAccountRow({ account, now, busy, onPatch, onUsage, onDelete }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.id, disabled: busy });
  const quota = account.usage?.quotas?.session;
  const blocking = account.usage?.quotas?.blocking;
  const credits = account.usage?.resetCredits ?? 0;
  const label = account.email || account.accountIdMasked || account.id;

  const refreshUsage = () => void (async () => {
    try { onUsage((await api.post<{ account: CodexAccount }>(`/api/admin/codex/accounts/${account.id}/usage`)).account); toast.success(`Usage refreshed: ${label}`); }
    catch (e) { toast.error((e as Error).message || 'Usage refresh failed'); }
  })();
  const resetQuota = () => {
    if (!window.confirm(`Spend 1 weekly reset credit to restart the 5h window for ${label}?`)) return;
    void (async () => {
      try { onUsage((await api.post<{ account: CodexAccount }>(`/api/admin/codex/accounts/${account.id}/reset-quota`)).account); toast.success(`Quota reset: ${label}`); }
      catch (e) { toast.error((e as Error).message || 'Quota reset failed'); }
    })();
  };
  const testConnection = () => void actRaw(`Test passed: ${label}`, () => api.post(`/api/admin/codex/accounts/${account.id}/test`));

  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn(account.enabled ? undefined : 'opacity-60', isDragging && 'relative z-10 bg-muted/60 shadow-sm')}
    >
      <TableCell className="w-8 pr-0">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${label}`}
          title="Drag to change routing order"
          disabled={busy}
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </TableCell>
      <TableCell>
        <div className="text-sm">{account.email || 'Unknown email'}</div>
        <div className="text-xs text-muted-foreground">
          {account.accountIdMasked || '—'}{account.workspaceIdMasked ? ` · ${account.workspaceIdMasked}` : ''}
          {account.usageError ? ` · usage: ${account.usageError}` : ''}
        </div>
      </TableCell>
      <TableCell className="text-sm">{account.usage?.plan || account.planType || '—'}</TableCell>
      <TableCell>{windowCell(quota, now, '5h')}</TableCell>
      <TableCell>{windowCell(blocking, now, 'Week')}</TableCell>
      <TableCell>
        <span className={`text-sm tabular-nums ${credits > 0 ? 'font-medium' : 'text-muted-foreground'}`}>{credits}</span>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switchish checked={account.autostart} disabled={busy} onCheckedChange={(value) => onPatch({ autostart: value })} label={`Auto-start 5h window for ${label}`} />
          <Tooltip>
            <TooltipTrigger asChild><span className="text-xs text-muted-foreground">{account.lastPingAt ? `pinged ${new Date(account.lastPingAt).toLocaleTimeString()}` : 'never pinged'}</span></TooltipTrigger>
            <TooltipContent className="max-w-64">Sends a tiny gpt-5.5 request right after the 5h window resets so the next window starts immediately. Consumes a small amount of quota.</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
      <TableCell className="text-xs">{new Date(account.tokenExpiresAt).toLocaleString()}</TableCell>
      <TableCell>
        <Badge variant={account.healthState === 'healthy' ? 'success' : account.healthState === 'down' ? 'destructive' : 'secondary'}>{account.healthState}</Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" aria-label={`Refresh usage for ${label}`} disabled={busy} onClick={refreshUsage}><RefreshCw className="h-3 w-3" /></Button>
            </TooltipTrigger>
            <TooltipContent>Refresh usage</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" aria-label={`Reset quota for ${label}`} disabled={busy || credits === 0} onClick={resetQuota}><RotateCcw className="h-3 w-3" /></Button>
            </TooltipTrigger>
            <TooltipContent>{credits === 0 ? 'No weekly reset credits available' : 'Reset quota (uses 1 credit)'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" aria-label={`Test Codex account ${label}`} disabled={busy} onClick={testConnection}><Settings2 className="h-3 w-3" /></Button>
            </TooltipTrigger>
            <TooltipContent>Test connection</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" aria-pressed={!account.enabled} disabled={busy} onClick={() => onPatch({ enabled: !account.enabled })}>{account.enabled ? 'Disable' : 'Enable'}</Button>
            </TooltipTrigger>
            <TooltipContent>{account.enabled ? 'Exclude from routing (keeps the account)' : 'Include in routing'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="destructive" aria-label={`Delete Codex account ${label}`} disabled={busy} onClick={() => {
                if (!window.confirm(`Permanently delete ${label}?\n\nStored Codex credentials are erased. Past request logs are kept, but lose the account reference.`)) return;
                onDelete();
              }}><Trash2 className="h-3 w-3" /></Button>
            </TooltipTrigger>
            <TooltipContent>Delete account (permanent)</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Shares the busy/toast contract of the panel-level `act` helper for row-local actions. */
async function actRaw(label: string, run: () => Promise<unknown>) {
  try { await run(); toast.success(label); } catch (e) { toast.error((e as Error).message || 'Action failed'); }
}

/** Switch with an accessible label; kept local to avoid repeating aria wiring per row. */
function Switchish({ checked, disabled, onCheckedChange, label }: { checked: boolean; disabled?: boolean; onCheckedChange: (value: boolean) => void; label: string }) {
  return <Checkbox role="switch" aria-label={label} aria-checked={checked} checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)} />;
}
