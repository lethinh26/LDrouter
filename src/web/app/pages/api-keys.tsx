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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { Portal as TooltipPortal } from '@radix-ui/react-tooltip';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Plus, Copy, Eye, Trash2, Ban, CheckCircle2, Pencil, HelpCircle } from 'lucide-react';

interface KeyRow { id: string; name: string; keyPrefix: string; enabled: boolean; expiresAt: string | null; lastUsedAt: string | null; allowAllModels: boolean; modelScopeCount: number; rpmLimit: number | null; tpmLimit: number | null; concurrencyLimit: number | null; dailyTokenLimit: number | null; monthlyTokenLimit: number | null; totalTokenLimit: number | null; totalTokensUsed: number; maxOutputTokensPerRequest: number | null; cacheOverrideEnabled: boolean | null; secret: string | null; }
interface Model { id: string; publicModelId: string; }
interface Combo { id: string; publicModelId: string; }
interface Alias { id: string; alias: string; }
interface Perm { targetKind: 'model' | 'combo' | 'alias'; targetId: string; }
interface IpRule { mode: 'allow' | 'deny'; cidr: string; }
type KeyDetail = Omit<KeyRow, 'concurrencyLimit'> & { maxConcurrent: number | null; permissions: Perm[]; ipRules: IpRule[] };
const limits = [
  { field: 'rpmLimit', label: 'RPM limit', help: 'Requests per minute. A token bucket allows short bursts up to this value.' },
  { field: 'tpmLimit', label: 'TPM limit', help: 'Tokens per minute, including input and output. The gateway reserves an estimate and reconciles it with usage.' },
  { field: 'concurrency', label: 'Concurrency', help: 'Maximum requests in progress at the same time, including streaming requests.' },
  { field: 'dailyTokenLimit', label: 'Daily tokens', help: 'Total input and output tokens per UTC calendar day. Resets at midnight UTC.' },
  { field: 'monthlyTokenLimit', label: 'Monthly tokens', help: 'Total input and output tokens per UTC calendar month. Resets on the first day of the month.' },
  { field: 'totalTokenLimit', label: 'Total tokens (lifetime)', help: 'Cumulative input and output tokens for this key, across all months. Never resets automatically; requests exceeding the remaining estimated budget are rejected.' },
  { field: 'maxOutputTokensPerRequest', label: 'Max output tokens / request', help: 'Caps generated tokens per request. Larger requested values are reduced; if omitted, the gateway uses at most 1,024 or this cap, whichever is smaller.' },
] as const;

function emptyForm() {
  return { name: '', expiresAt: '', enabled: true, allowAll: true, permissions: [] as Perm[], rpmLimit: '', tpmLimit: '', concurrency: '', dailyTokenLimit: '', monthlyTokenLimit: '', totalTokenLimit: '', maxOutputTokensPerRequest: '', cache: 'inherit', ipRules: [] as IpRule[], customSecret: '' };
}

function localDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
}

function limitValue(value: string, label: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive whole number or left empty.`);
  return n;
}

function HelpLabel({ label, help, htmlFor }: { label: string; help: string; htmlFor?: string }) {
  return <div className="flex items-center gap-1.5"><Label htmlFor={htmlFor}>{label}</Label><Tooltip><TooltipTrigger asChild><button type="button" aria-label={`About ${label}`} className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><HelpCircle className="size-3.5" /></button></TooltipTrigger><TooltipPortal><TooltipContent side="top" className="max-w-xs leading-relaxed">{help}</TooltipContent></TooltipPortal></Tooltip></div>;
}

function formatDate(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
}

async function copySecret(secret: string) {
  try { await navigator.clipboard.writeText(secret); toast.success('Copied'); }
  catch { toast.error('Clipboard unavailable. Open the key and copy the text manually.'); }
}

export function ApiKeys() {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [scopeSearch, setScopeSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ secret: string; name: string } | null>(null);
  const [revealRow, setRevealRow] = useState<{ secret: string; name: string } | null>(null);
  const [form, setForm] = useState(emptyForm);

  const reload = async () => {
    setLoading(true);
    try {
      const [k, m, c, a] = await Promise.all([
        api.get<{ apiKeys: KeyRow[] }>('/api/admin/api-keys'),
        api.get<{ models: Model[] }>('/api/admin/models'),
        api.get<{ combos: Combo[] }>('/api/admin/combos'),
        api.get<{ aliases: Alias[] }>('/api/admin/aliases'),
      ]);
      setRows(k.apiKeys); setModels(m.models); setCombos(c.combos); setAliases(a.aliases);
      setLoadError('');
    } catch (e) { setLoadError((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(), enabled: form.enabled,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        allowAllModels: form.allowAll,
        permissions: form.allowAll ? [] : form.permissions.map(({ targetKind, targetId }) => ({ targetKind, targetId })),
        rpmLimit: limitValue(form.rpmLimit, 'RPM limit'),
        tpmLimit: limitValue(form.tpmLimit, 'TPM limit'),
        maxConcurrent: limitValue(form.concurrency, 'Concurrency'),
        dailyTokenLimit: limitValue(form.dailyTokenLimit, 'Daily tokens'),
        monthlyTokenLimit: limitValue(form.monthlyTokenLimit, 'Monthly tokens'),
        totalTokenLimit: limitValue(form.totalTokenLimit, 'Total tokens'),
        maxOutputTokensPerRequest: limitValue(form.maxOutputTokensPerRequest, 'Max output tokens'),
        cacheOverrideEnabled: form.cache === 'inherit' ? null : form.cache === 'on',
        ipRules: form.ipRules.map(({ mode, cidr }) => ({ mode, cidr: cidr.trim() })),
      };
      if (!payload.name) throw new Error('Name is required.');
      if (payload.ipRules.some((rule) => !rule.cidr)) throw new Error('Complete or remove each empty IP rule.');
      if (editingId) {
        await api.patch('/api/admin/api-keys', {
          id: editingId,
          ...payload,
        });
        setOpen(false);
        setEditingId(null);
        setForm(emptyForm());
        toast.success('Key updated');
        void reload();
        return;
      }
      const r = await api.post<{ secret: string; name: string }>('/api/admin/api-keys', {
        ...payload,
        ...(form.customSecret.trim() ? { secret: form.customSecret.trim() } : {}),
      });
      setOpen(false);
      setReveal({ secret: r.secret, name: r.name });
      setForm(emptyForm());
      void reload();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const openEdit = async (k: KeyRow) => {
    try {
      const { apiKey: detail } = await api.get<{ apiKey: KeyDetail }>(`/api/admin/api-keys/${k.id}`);
      setEditingId(k.id);
      setForm({
        name: detail.name,
        expiresAt: localDate(detail.expiresAt),
        enabled: detail.enabled,
        allowAll: detail.allowAllModels,
        permissions: detail.permissions ?? [],
        rpmLimit: detail.rpmLimit?.toString() ?? '',
        tpmLimit: detail.tpmLimit?.toString() ?? '',
        concurrency: detail.maxConcurrent?.toString() ?? '',
        dailyTokenLimit: detail.dailyTokenLimit?.toString() ?? '',
        monthlyTokenLimit: detail.monthlyTokenLimit?.toString() ?? '',
        totalTokenLimit: detail.totalTokenLimit?.toString() ?? '',
        maxOutputTokensPerRequest: detail.maxOutputTokensPerRequest?.toString() ?? '',
        cache: detail.cacheOverrideEnabled == null ? 'inherit' : detail.cacheOverrideEnabled ? 'on' : 'off',
        ipRules: (detail.ipRules ?? []).map(({ mode, cidr }) => ({ mode, cidr })),
        customSecret: '', // the secret is never changed on edit
      });
      setScopeSearch('');
      setOpen(true);
    } catch (e) { toast.error((e as Error).message); }
  };

  const cancelEdit = () => {
    setOpen(false);
    setEditingId(null);
    setForm(emptyForm());
    setScopeSearch('');
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

  const targets: Array<Perm & { label: string; group: string }> = [
    ...combos.map((c) => ({ targetKind: 'combo' as const, targetId: c.id, label: c.publicModelId, group: 'Combos' })),
    ...aliases.map((a) => ({ targetKind: 'alias' as const, targetId: a.id, label: a.alias, group: 'Aliases' })),
    ...models.map((m) => ({ targetKind: 'model' as const, targetId: m.id, label: m.publicModelId, group: `Models · ${m.publicModelId.split('/')[0]}` })),
  ];
  for (const p of form.permissions) if (!targets.some((t) => t.targetId === p.targetId && t.targetKind === p.targetKind)) targets.push({ ...p, label: p.targetId, group: 'Unavailable targets' });
  const filteredTargets = targets.filter((t) => `${t.label} ${t.group}`.toLowerCase().includes(scopeSearch.toLowerCase().trim()));

  return (
    <TooltipProvider delayDuration={200}>
    <div>
      <PageHeader title="API Keys" description="Gateway bearer keys for client applications" actions={
        <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) cancelEdit(); else if (o) { setScopeSearch(''); setOpen(true); } }}>
          <DialogTrigger asChild><Button disabled={loading || !!loadError}><Plus className="mr-1 h-4 w-4" /> New key</Button></DialogTrigger>
          <DialogContent className="max-h-[90dvh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader><DialogTitle>{editingId ? 'Edit API key' : 'New API key'}</DialogTitle><DialogDescription>Configure access, token budgets and security rules for this key.</DialogDescription></DialogHeader>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5"><HelpLabel label="Name" htmlFor="key-name" help="A descriptive name to identify the client or application in the dashboard and usage logs." /><Input id="key-name" maxLength={128} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div className="flex flex-col gap-1.5"><HelpLabel label="Expires (optional)" htmlFor="key-expiry" help="The key stops authenticating at this date and time, shown in your local time zone. Leave empty for no expiration." /><Input id="key-expiry" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></div>
              </div>
              <div className="flex items-center gap-2"><Switch id="key-enabled" checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /><HelpLabel label="Enabled" htmlFor="key-enabled" help="Turn off to immediately block new requests without deleting the key or its settings." /></div>
              {!editingId && (
                <div className="flex flex-col gap-1.5"><HelpLabel label="Key value (optional)" htmlFor="key-secret" help="Leave blank to generate a secure random ld- key. A custom secret is accepted and stored encrypted; it cannot be changed on edit." /><Input id="key-secret" maxLength={256} value={form.customSecret} onChange={(e) => setForm({ ...form, customSecret: e.target.value })} placeholder="Leave empty to auto-generate ld-…" autoComplete="off" /></div>
              )}
              <div className="flex flex-col gap-2 border-t pt-3">
                <div><p className="text-sm font-medium">Rate &amp; token limits</p><p className="text-xs text-muted-foreground">Leave any field empty for unlimited usage in that dimension.</p></div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {limits.map((limit) => <div key={limit.field} className="flex flex-col gap-1.5"><HelpLabel label={limit.label} htmlFor={`key-${limit.field}`} help={limit.help} /><Input id={`key-${limit.field}`} value={form[limit.field]} onChange={(e) => setForm({ ...form, [limit.field]: e.target.value })} type="number" min={1} step={1} placeholder="Unlimited" /></div>)}
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t pt-3">
              <div className="flex items-center gap-2"><Switch id="key-allow-all" checked={form.allowAll} onCheckedChange={(v) => setForm({ ...form, allowAll: v })} /><HelpLabel label="Allow all current and future models" htmlFor="key-allow-all" help="If disabled, only explicitly selected models, combos or aliases can be used. An empty selection denies all generation." /></div>
              {!form.allowAll && (
                <div className="flex flex-col gap-2">
                  <HelpLabel label={`Scope (${form.permissions.length} selected)`} help="A combo or alias grant does not grant direct access to its underlying physical models. A direct model or combo grant also permits its aliases." />
                  <Input aria-label="Search permitted targets" placeholder="Search models, combos, aliases…" value={scopeSearch} onChange={(e) => setScopeSearch(e.target.value)} />
                  <div className="max-h-48 overflow-auto rounded border p-2">
                    {filteredTargets.length === 0 && <p className="p-2 text-xs text-muted-foreground">No matching targets.</p>}
                    {[...new Set(filteredTargets.map((t) => t.group))].map((group) => <div key={group} className="flex flex-col gap-1"><p className="px-1 pt-1 text-xs font-medium text-muted-foreground">{group}</p>{filteredTargets.filter((t) => t.group === group).map((t) => {
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
                    })}</div>)}
                  </div>
                </div>
              )}
              </div>
              <div className="flex flex-col gap-2 border-t pt-3">
                <HelpLabel label="Gateway response cache" help="Inherit the default key policy, explicitly allow, or disable response caching for this key. Global and target restrictions still apply. Streaming responses are not cached." />
                <Select value={form.cache} onValueChange={(v) => setForm({ ...form, cache: v })}><SelectTrigger aria-label="Gateway response cache"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="inherit">Inherit default</SelectItem><SelectItem value="on">Allow when policy permits</SelectItem><SelectItem value="off">Disable</SelectItem></SelectGroup></SelectContent></Select>
              </div>
              <div className="flex flex-col gap-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2"><HelpLabel label="IP access rules" help="Use IPv4/IPv6 addresses or CIDR ranges. Deny rules take precedence. If any allow rule exists, the client IP must match at least one. No rules means no IP restriction." /><Button type="button" size="sm" variant="outline" onClick={() => setForm((f) => ({ ...f, ipRules: [...f.ipRules, { mode: 'allow', cidr: '' }] }))}><Plus /> Add rule</Button></div>
                {form.ipRules.length === 0 && <p className="text-xs text-muted-foreground">No IP restrictions.</p>}
                {form.ipRules.map((rule, i) => <div key={i} className="flex items-center gap-2"><div className="w-28 shrink-0"><Select value={rule.mode} onValueChange={(mode) => setForm((f) => ({ ...f, ipRules: f.ipRules.map((r, j) => j === i ? { ...r, mode: mode as IpRule['mode'] } : r) }))}><SelectTrigger aria-label={`Rule ${i + 1} action`}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="allow">Allow</SelectItem><SelectItem value="deny">Deny</SelectItem></SelectGroup></SelectContent></Select></div><Input aria-label={`Rule ${i + 1} IP or CIDR`} placeholder="192.168.1.0/24 or 2001:db8::/32" value={rule.cidr} onChange={(e) => setForm((f) => ({ ...f, ipRules: f.ipRules.map((r, j) => j === i ? { ...r, cidr: e.target.value } : r) }))} /><Button type="button" size="icon" variant="ghost" aria-label={`Remove IP rule ${i + 1}`} onClick={() => setForm((f) => ({ ...f, ipRules: f.ipRules.filter((_, j) => j !== i) }))}><Trash2 /></Button></div>)}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={saving} onClick={cancelEdit}>Cancel</Button>
              <Button disabled={!form.name.trim() || saving} onClick={submit}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      } />
      <Card>
        <CardHeader><CardTitle className="text-base">All keys</CardTitle><CardDescription>{rows.length} total</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Prefix</TableHead><TableHead>Status</TableHead><TableHead>Scope</TableHead><TableHead>Limits</TableHead><TableHead>Total tokens</TableHead><TableHead>Last used</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {loadError && <TableRow><TableCell colSpan={8} className="text-center text-destructive">{loadError} <Button size="sm" variant="outline" onClick={() => void reload()}>Retry</Button></TableCell></TableRow>}
              {!loadError && rows.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">{loading ? 'Loading API keys…' : 'No API keys yet.'}</TableCell></TableRow>}
              {rows.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">{k.keyPrefix}…</TableCell>
                  <TableCell><div className="flex flex-col items-start gap-1">{!k.enabled ? <Badge variant="destructive">Disabled</Badge> : k.expiresAt && !(Date.parse(k.expiresAt) > Date.now()) ? <Badge variant="warning">Expired</Badge> : <Badge variant="success">Enabled</Badge>}{k.expiresAt && <span className="text-xs text-muted-foreground">Expires: {formatDate(k.expiresAt)}</span>}</div></TableCell>
                  <TableCell>{k.allowAllModels ? 'all' : `${k.modelScopeCount} scoped`}</TableCell>
                  <TableCell className="text-xs"><div className="flex flex-wrap gap-1">{[[k.rpmLimit, 'RPM'], [k.tpmLimit, 'TPM'], [k.concurrencyLimit, 'Concurrent'], [k.dailyTokenLimit, '/day'], [k.monthlyTokenLimit, '/month'], [k.maxOutputTokensPerRequest, 'output/request']].map(([value, unit]) => value != null ? <Badge key={String(unit)} variant="outline" className="whitespace-nowrap">{Number(value).toLocaleString()} {unit}</Badge> : null)}{[k.rpmLimit, k.tpmLimit, k.concurrencyLimit, k.dailyTokenLimit, k.monthlyTokenLimit, k.maxOutputTokensPerRequest].every((value) => value == null) && 'Unlimited'}</div></TableCell>
                  <TableCell className="text-xs tabular-nums whitespace-nowrap">{k.totalTokensUsed.toLocaleString()} / {k.totalTokenLimit?.toLocaleString() ?? 'Unlimited'}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{formatDate(k.lastUsedAt)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {k.secret && (
                        <>
                          <Button size="sm" variant="ghost" title="Copy secret" aria-label="Copy secret" onClick={() => void copySecret(k.secret!)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Show secret" aria-label="Show secret" onClick={() => setRevealRow({ secret: k.secret!, name: k.name })}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="ghost" title="Edit" aria-label="Edit API key" onClick={() => void openEdit(k)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => toggle(k.id, k.enabled)}>
                        {k.enabled ? <Ban className="mr-1 h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                        {k.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="destructive" aria-label="Delete API key" onClick={() => del(k.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
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
            <DialogDescription>Copy this secret for your client. You can also reveal it from the key list later.</DialogDescription>
          </DialogHeader>
          <div className="rounded border bg-muted p-3 font-mono text-xs break-all">{reveal?.secret}</div>
          <DialogFooter>
            <Button onClick={() => { if (reveal) void copySecret(reveal.secret); }}><Copy className="mr-1 h-4 w-4" /> Copy</Button>
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
            <Button onClick={() => { if (revealRow) void copySecret(revealRow.secret); }}><Copy className="mr-1 h-4 w-4" /> Copy</Button>
            <Button variant="outline" onClick={() => setRevealRow(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
