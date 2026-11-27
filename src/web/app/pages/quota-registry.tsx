import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, Plus, RefreshCw, Pencil, Trash2, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../components/ui/alert-dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

const endpoint = '/api/admin/subscription-quotas';
const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
type Kind = 'codex' | 'claude_code';
type Window = { label: string; usedPercent: number; windowDurationMins: number | null; resetsAt: string | null };
type Snapshot = {
  source: 'manual' | 'codex_app_server' | 'codex_client_sync'; observedAt: string; plan: string | null;
  ordinaryUsageAllowed: boolean | null; windows: Window[];
};
type Account = {
  id: string; providerKind: Kind; name: string; createdAt: string; updatedAt: string;
  identityBound: boolean; snapshot: Snapshot | null;
  sync: { expiresAt: string; lastSyncedAt: string | null } | null;
};
type DraftWindow = { label: string; used: string; duration: string; reset: string };
type Editor = { kind: 'create' } | { kind: 'rename' | 'observe'; account: Account };
const newWindow = (): DraftWindow => ({ label: '', used: '', duration: '', reset: '' });
const providerLabel = (kind: Kind) => kind === 'codex' ? 'Codex' : 'Claude Code';
const dateLabel = (value: string) => new Date(value).toLocaleString();
const localDate = (value: string | number = Date.now()) => {
  const date = new Date(value);
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex quota JSON');
  return value as Record<string, unknown>;
};

// Keep only the documented quota fields; do not send unrelated RPC metadata,
// credits, session data or credentials from a pasted result.
export function extractCodexQuotaResult(raw: string): Record<string, unknown> {
  if (raw.length > 32768) throw new Error('Quota JSON is too large');
  const parsed = object(JSON.parse(raw));
  const result = object('result' in parsed ? parsed.result : parsed);
  const pickWindow = (value: unknown) => {
    if (value == null) return value;
    const w = object(value);
    return { usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt };
  };
  const pickBucket = (value: unknown) => {
    const b = object(value);
    return { limitId: b.limitId, limitName: b.limitName, planType: b.planType,
      primary: pickWindow(b.primary), secondary: pickWindow(b.secondary) };
  };
  const entries = result.rateLimitsByLimitId == null ? null : Object.entries(object(result.rateLimitsByLimitId));
  if (entries && entries.length > 16) throw new Error('Too many quota buckets');
  return {
    accountId: result.accountId, ordinaryUsageAllowed: result.ordinaryUsageAllowed,
    rateLimits: pickBucket(result.rateLimits),
    rateLimitsByLimitId: entries === null ? null : Object.fromEntries(entries.map(([id, b]) => [id, pickBucket(b)])),
  };
}

export function quotaIsStale(snapshot: Snapshot, now: number): boolean {
  const observed = Date.parse(snapshot.observedAt);
  return !Number.isFinite(observed) || observed > now + 300000 || now - observed >= 15 * 60000 ||
    snapshot.windows.some(w => w.resetsAt !== null && Date.parse(w.resetsAt) <= now);
}

function manualWindows(drafts: DraftWindow[]): Window[] {
  return drafts.map(w => {
    const used = Number(w.used);
    const duration = w.duration.trim() === '' ? null : Number(w.duration);
    if (!w.label.trim() || !w.used.trim() || !Number.isFinite(used) || used < 0 || used > 100 ||
        (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 525600))) {
      throw new Error('Enter a label, a percentage from 0 to 100, and valid optional window minutes');
    }
    return { label: w.label.trim(), usedPercent: used, windowDurationMins: duration,
      resetsAt: w.reset ? new Date(w.reset).toISOString() : null };
  });
}

export function QuotaRegistry() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('codex');
  const [source, setSource] = useState<'manual' | 'codex_app_server'>('manual');
  const [observed, setObserved] = useState('');
  const [plan, setPlan] = useState('');
  const [windows, setWindows] = useState<DraftWindow[]>([newWindow()]);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState<Account | null>(null);
  const [pairingToken, setPairingToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const sequence = useRef(0);
  const locked = useRef(false);
  const invalidateLoad = useCallback(() => { ++sequence.current; }, []);
  const reload = useCallback(async (background = false) => {
    const seq = ++sequence.current;
    if (!background) setLoading(true);
    setLoadError(false);
    try {
      const data = await api.get<{ accounts: Account[] }>(endpoint);
      if (seq !== sequence.current) return;
      setAccounts(data.accounts);
      setNow(Date.now());
    } catch {
      if (seq === sequence.current) setLoadError(true);
    } finally { if (seq === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => { clearInterval(timer); invalidateLoad(); };
  }, [reload, invalidateLoad]);
  const activeSync = accounts.some(a => a.sync && Date.parse(a.sync.expiresAt) > now);
  useEffect(() => {
    if (!activeSync) return;
    const timer = setInterval(() => { if (!locked.current) void reload(true); }, 30000);
    return () => clearInterval(timer);
  }, [activeSync, reload]);
  const unavailable = loading || loadError || busy;
  function clearEditor() {
    setEditor(null); setRaw(''); setError('');
  }
  function openEditor(next: Editor) {
    setError(''); setRaw('');
    setName(next.kind === 'create' ? '' : next.account.name);
    setKind(next.kind === 'create' ? 'codex' : next.account.providerKind);
    setSource('manual'); setObserved(localDate());
    const snapshot = next.kind === 'observe' ? next.account.snapshot : null;
    setPlan('');
    setWindows(snapshot?.windows.length ? snapshot.windows.map(w => ({
      label: w.label, used: '', duration: w.windowDurationMins === null ? '' : String(w.windowDurationMins),
      reset: '',
    })) : [newWindow()]);
    setEditor(next);
  }
  function changeWindow(index: number, patch: Partial<DraftWindow>) {
    setWindows(current => current.map((w, i) => i === index ? { ...w, ...patch } : w));
  }
  async function submit() {
    if (!editor || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      if (editor.kind === 'create') {
        await api.post(endpoint, { providerKind: kind, name: name.trim() });
      } else if (editor.kind === 'rename') {
        await api.patch(endpoint + '/' + editor.account.id, { name: name.trim() });
      } else {
        const observedAt = new Date(observed).toISOString();
        const payload = source === 'manual' ?
          { source, observedAt, plan: plan.trim() || null, windows: manualWindows(windows) } :
          { source, observedAt, result: extractCodexQuotaResult(raw) };
        await api.post(endpoint + '/' + editor.account.id + '/snapshot', payload);
      }
      clearEditor();
      toast.success('Quota record saved');
      await reload();
    } catch (e) {
      // Do not show a parser exception that may echo pasted raw JSON.
      setError(e instanceof Error && e.name === 'SyntaxError' ? 'Invalid quota JSON' :
        e instanceof Error && e.name !== 'RangeError' ? e.message : 'Invalid date or quota data');
    } finally { locked.current = false; setBusy(false); }
  }
  async function remove() {
    if (!deleting || locked.current) return;
    locked.current = true; setBusy(true);
    try {
      await api.del(endpoint + '/' + deleting.id);
      setDeleting(null); toast.success('Quota record deleted'); await reload();
    } catch { toast.error('Could not delete quota record'); }
    finally { locked.current = false; setBusy(false); }
  }
  function closePairing() {
    if (locked.current) return;
    setPairing(null); setPairingToken(null);
  }
  async function generatePairing() {
    if (!pairing || locked.current) return;
    locked.current = true; setBusy(true);
    try {
      const result = await api.post<{ token: string; expiresAt: string }>(endpoint + '/' + pairing.id + '/sync', {});
      setPairingToken(result);
      await reload();
    } catch { toast.error('Could not create a quota pairing. Use HTTPS or local loopback.'); }
    finally { locked.current = false; setBusy(false); }
  }
  async function stopSync(account: Account) {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      await api.del(endpoint + '/' + account.id + '/sync');
      toast.success('Quota pairing revoked'); await reload();
    } catch { toast.error('Could not revoke quota pairing'); }
    finally { locked.current = false; setBusy(false); }
  }
  async function copy(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); toast.success(message); }
    catch { toast.error('Clipboard unavailable; select and copy manually'); }
  }
  const syncCommand = pairing ? 'ldrouter-quota-sync --gateway ' + (window.location.protocol === 'http:' && window.location.hostname === 'localhost' ? window.location.origin.replace('localhost', '127.0.0.1') : window.location.origin) + ' --account ' + pairing.id + ' --interval 300' : '';
  return <Card aria-label="Subscription quotas">
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-5 w-5" />Subscription quotas</CardTitle>
          <CardDescription className="mt-1">Track each subscription account separately. Observations only, not live authorization or routing limits.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => void reload()}><RefreshCw className="mr-1 h-4 w-4" />Refresh records</Button>
          <Button size="sm" disabled={unavailable} onClick={() => openEditor({ kind: 'create' })}><Plus className="mr-1 h-4 w-4" />Add quota account</Button>
        </div>
      </div>
    </CardHeader>
    <CardContent className="space-y-3">
      <p className="text-xs text-muted-foreground">No subscription login tokens are collected. Pair a signed-in local Codex client to sync quota observations automatically, or import them manually. Claude Code uses manually recorded Usage observations. Refresh records reloads stored data, not provider quota.</p>
      {loadError ? <p role="alert" className="text-sm text-destructive">Could not load quota records. Refresh to retry.</p> : loading ? <p role="status" className="text-sm text-muted-foreground">Loading quota accounts…</p> :
        accounts.length === 0 ? <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No quota accounts yet.</p> :
        <div className="grid gap-3 xl:grid-cols-2">
          {accounts.map(account => {
            const snapshot = account.snapshot;
            const stale = snapshot !== null && quotaIsStale(snapshot, now);
            const paired = account.sync && Date.parse(account.sync.expiresAt) > now;
            return <section key={account.id} aria-label={'Quota account ' + account.name} className="space-y-3 rounded-md border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-all font-medium">{account.name}</h3>
                  <p className="text-xs text-muted-foreground">{providerLabel(account.providerKind)}{snapshot?.plan ? ' · ' + snapshot.plan : ''}</p>
                </div>
                <Badge variant={stale ? 'warning' : 'outline'}>{!snapshot ? 'Not observed' : stale ? 'Stale observation' : 'Recent observation'}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{account.identityBound ? 'Imported identifier bound (not independently verified)' : 'Operator-selected account identity'}</p>
              {snapshot ? <>
                <p className="text-xs text-muted-foreground">{snapshot.source === 'manual' ? 'Manually recorded' : snapshot.source === 'codex_client_sync' ? 'Synced from local Codex client' : 'Imported Codex app-server result'} · Observed {dateLabel(snapshot.observedAt)}</p>
                {snapshot.ordinaryUsageAllowed !== null && <p className="text-xs">Ordinary usage reported {snapshot.ordinaryUsageAllowed ? 'allowed' : 'not allowed'} at observation time.</p>}
                {snapshot.windows.length === 0 && <p className="text-sm text-muted-foreground">No quota windows reported.</p>}
                {snapshot.windows.map(w => <div key={w.label} className="space-y-1 rounded-md bg-muted/30 p-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-1 text-sm"><span className="break-all font-medium">{w.label}</span><span className="tabular-nums">{w.usedPercent}% used · {Math.round((100 - w.usedPercent) * 100) / 100}% remaining</span></div>
                  <div role="progressbar" aria-label={w.label + ' used'} aria-valuenow={w.usedPercent} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className={'h-full rounded-full ' + (w.usedPercent >= 90 ? 'bg-destructive' : 'bg-primary')} style={{ width: w.usedPercent + '%' }} />
                  </div>
                  <p className="text-xs text-muted-foreground">{w.windowDurationMins === null ? 'Duration not reported' : w.windowDurationMins + ' min window'} · {w.resetsAt === null ? 'Reset not reported' : 'Reported reset ' + dateLabel(w.resetsAt)}</p>
                </div>)}
                {stale && <p className="text-xs text-muted-foreground">Refresh from the official client. A passed reset time does not establish renewed quota.</p>}
              </> : <p className="text-sm text-muted-foreground">Usage and reset times are unknown.</p>}
              {account.providerKind === 'codex' && <div className="rounded-md border p-2 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2"><span className="font-medium">Local quota sync</span><Badge variant="outline">{paired ? 'Paired' : 'Not paired'}</Badge></div>
                {paired && account.sync && <><p>Pairing expires {dateLabel(account.sync.expiresAt)}</p><p className="text-muted-foreground">{account.sync.lastSyncedAt ? 'Last upload ' + dateLabel(account.sync.lastSyncedAt) : 'Waiting for first client upload'}</p></>}
                <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={unavailable} onClick={() => { setPairing(account); setPairingToken(null); }}>{paired ? 'Replace sync token' : 'Set up sync'}</Button>
                  {paired && <Button size="sm" variant="outline" disabled={unavailable} onClick={() => void stopSync(account)}>Revoke sync</Button>}</div>
              </div>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={unavailable} onClick={() => openEditor({ kind: 'observe', account })}>Update observation</Button>
                <Button size="sm" variant="outline" disabled={unavailable} aria-label={'Rename quota account ' + account.name} onClick={() => openEditor({ kind: 'rename', account })}><Pencil className="h-4 w-4" /></Button>
                <Button size="sm" variant="outline" disabled={unavailable} aria-label={'Delete quota account ' + account.name} onClick={() => setDeleting(account)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </section>;
          })}
        </div>}
    </CardContent>
    <Dialog open={editor !== null} onOpenChange={open => { if (!open && !locked.current) clearEditor(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editor?.kind === 'create' ? 'Add quota account' : editor?.kind === 'rename' ? 'Rename quota account' : 'Update quota observation'}</DialogTitle>
          <DialogDescription>{editor?.kind === 'observe' ? 'Record the values reported for this account at the observation time. No authentication or live polling.' : 'A named monitoring record, independent of routing connections.'}</DialogDescription>
        </DialogHeader>
        {editor?.kind !== 'observe' ? <div className="space-y-3">
          {editor?.kind === 'create' && <div className="space-y-1"><Label htmlFor="quota-provider">Provider</Label><select id="quota-provider" className={inputClass} value={kind} disabled={busy} onChange={e => setKind(e.target.value as Kind)}><option value="codex">Codex</option><option value="claude_code">Claude Code</option></select></div>}
          <div className="space-y-1"><Label htmlFor="quota-name">Account name</Label><Input id="quota-name" value={name} maxLength={128} disabled={busy} onChange={e => setName(e.target.value)} placeholder="Personal subscription" /></div>
        </div> : <div className="space-y-3">
          <p className="break-all text-sm font-medium">{editor.account.name} · {providerLabel(editor.account.providerKind)}</p>
          <div className="space-y-1"><Label htmlFor="quota-source">Observation source</Label><select id="quota-source" className={inputClass} value={source} disabled={busy} onChange={e => { setSource(e.target.value as 'manual' | 'codex_app_server'); setRaw(''); }}>
            <option value="manual">Manual entry from official Usage</option>
            {editor.account.providerKind === 'codex' && <option value="codex_app_server">Import Codex app-server result</option>}
          </select></div>
          <div className="space-y-1"><Label htmlFor="quota-observed">Observed at (local time)</Label><Input id="quota-observed" type="datetime-local" step={1} value={observed} disabled={busy} onChange={e => setObserved(e.target.value)} /></div>
          {source === 'codex_app_server' ? <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Paste the result of <code>account/rateLimits/read</code> from your signed-in official Codex app-server, not auth files or tokens. <a className="underline" href="https://learn.chatgpt.com/docs/app-server" target="_blank" rel="noreferrer">Protocol documentation</a>.</p>
            <Label htmlFor="quota-import">Codex rate-limit result JSON</Label>
            <textarea id="quota-import" className={inputClass + ' min-h-32 font-mono'} value={raw} maxLength={32768} disabled={busy} onChange={e => setRaw(e.target.value)} />
          </div> : <>
            <div className="space-y-1"><Label htmlFor="quota-plan">Plan (optional)</Label><Input id="quota-plan" value={plan} maxLength={64} disabled={busy} onChange={e => setPlan(e.target.value)} /></div>
            {windows.map((w, i) => <fieldset key={i} className="space-y-2 rounded-md border p-3" disabled={busy}>
              <legend className="px-1 text-xs font-medium">Window {i + 1}</legend>
              <Label htmlFor={'quota-label-' + i}>Window label</Label><Input id={'quota-label-' + i} value={w.label} maxLength={128} placeholder="5-hour limit" onChange={e => changeWindow(i, { label: e.target.value })} />
              <div className="grid grid-cols-2 gap-2"><div><Label htmlFor={'quota-used-' + i}>Used %</Label><Input id={'quota-used-' + i} type="number" min={0} max={100} step="any" value={w.used} onChange={e => changeWindow(i, { used: e.target.value })} /></div>
                <div><Label htmlFor={'quota-duration-' + i}>Minutes (optional)</Label><Input id={'quota-duration-' + i} type="number" min={1} step={1} value={w.duration} onChange={e => changeWindow(i, { duration: e.target.value })} /></div></div>
              <Label htmlFor={'quota-reset-' + i}>Reported reset (optional, local time)</Label><Input id={'quota-reset-' + i} type="datetime-local" step={1} value={w.reset} onChange={e => changeWindow(i, { reset: e.target.value })} />
              <Button size="sm" variant="ghost" disabled={windows.length <= 1 || busy} onClick={() => setWindows(current => current.filter((_, n) => n !== i))}>Remove window</Button>
            </fieldset>)}
            <Button size="sm" variant="outline" disabled={busy || windows.length >= 32} onClick={() => setWindows(current => [...current, newWindow()])}>Add window</Button>
          </>}
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={clearEditor}>Cancel</Button>
          <Button disabled={busy || (editor?.kind === 'observe' ? !observed || (source === 'codex_app_server' && !raw.trim()) : !name.trim())} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save quota record'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={pairing !== null} onOpenChange={open => { if (!open) closePairing(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Pair local Codex quota sync</DialogTitle><DialogDescription>Only quota observations are uploaded. Your Codex sign-in and provider credentials stay on your machine.</DialogDescription></DialogHeader>
        <p className="text-sm font-medium break-all">{pairing?.name}</p>
        {pairingToken ? <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Copy this one-time-displayed token. It can only update this quota record and expires {dateLabel(pairingToken.expiresAt)}. It is not a model API key.</p>
          <div className="space-y-1"><Label htmlFor="quota-pairing-token">Pairing token</Label><div className="flex gap-2"><Input id="quota-pairing-token" readOnly type="password" autoComplete="off" value={pairingToken.token} /><Button variant="outline" size="icon" aria-label="Copy pairing token" onClick={() => void copy(pairingToken.token, 'Pairing token copied')}><Copy className="h-4 w-4" /></Button></div></div>
          <p className="text-sm">On your own machine, use the matching LDrouter package and the signed-in official Codex CLI. Run this command, then paste the token at its hidden prompt.</p>
          <div className="rounded-md bg-muted p-3 text-xs break-all font-mono select-all">{syncCommand}</div>
          <Button variant="outline" size="sm" onClick={() => void copy(syncCommand, 'Command copied')}><Copy className="mr-2 h-4 w-4" />Copy command</Button>
          <p className="text-xs text-muted-foreground">Uploads every five minutes while the command is running. Ctrl+C stops it. Server restart, restore, expiry or revocation requires a new pairing. For one upload, omit --interval 300.</p>
        </div> : <div className="space-y-2 text-sm text-muted-foreground"><p>Generate a 24-hour, write-only token for this record. The first successful sync binds an unbound record to the account identifier reported by Codex. Use the intended account; identifiers are not independently verified by LDrouter.</p><p>Generating a new token immediately revokes the previous pairing. The client must report an account identifier; otherwise use manual import.</p></div>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={closePairing}>{pairingToken ? 'Done' : 'Cancel'}</Button>{!pairingToken && <Button disabled={busy} onClick={() => void generatePairing()}>Generate sync token</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={deleting !== null} onOpenChange={open => { if (!open && !locked.current) setDeleting(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Delete quota account?</AlertDialogTitle><AlertDialogDescription>This removes the monitoring record for {deleting?.name}, not any subscription, routing connection, or credential.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={e => { e.preventDefault(); void remove(); }}>Delete quota record</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
