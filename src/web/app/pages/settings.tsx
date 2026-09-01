import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '../../components/ui/alert-dialog';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { CheckCircle2, Download, Loader2, Bell, Volume2 } from 'lucide-react';
import { useNotificationPrefs, saveNotificationPrefs, loadNotificationPrefs } from '../../lib/notification-settings';
import { Textarea } from '../../components/ui/textarea';

interface Settings {
  setupComplete: boolean; retentionDays: number; contentLogMode: string; dbSizeLimitMb: number;
  trustProxyHops: number; gatewayCacheEnabled: boolean; gatewayCacheDefaultTtlSeconds: number;
  gatewayCacheMaxSizeMb: number; masterKeyConfigured: boolean; masterKeyVersion: number;
  notificationsEnabled: boolean; notificationSoundEnabled: boolean;
  adminIpAllow: string | null; adminIpBlock: string | null;
}

interface SysInfo { appVersion: string; dataDir: string; masterKeyConfigured: boolean; masterKeyVersion: number; environment: string; }

interface UpdateInfo {
  currentVersion: string; latestVersion: string | null; hasUpdate: boolean;
  changelogUrl: string | null; checkedAt: string;
  /** Docker only: is the Watchtower sidecar actually reachable right now */
  watchtowerReachable: boolean | null;
  status: { available: boolean; reason: string | null; updating: boolean; docker: boolean; watchtower: boolean };
}

export function Settings() {
  const [searchParams] = useSearchParams();
  const [s, setS] = useState<Settings | null>(null);
  const [sys, setSys] = useState<SysInfo | null>(null);
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  // IP access control draft state (saved only via the Save button — every
  // keystroke would otherwise fire a PATCH and fail CIDR validation).
  const [ipAllowDraft, setIpAllowDraft] = useState('');
  const [ipBlockDraft, setIpBlockDraft] = useState('');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<'idle' | 'checking' | 'installing' | 'restarting' | 'error'>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);

  const checkUpdate = async (force = false) => {
    setUpdatePhase('checking');
    setUpdateError(null);
    try {
      const r = await api.get<UpdateInfo>(`/api/admin/update/check${force ? '?force=1' : ''}`);
      setUpdateInfo(r);
      setUpdatePhase('idle');
    } catch (e) {
      setUpdateError((e as Error).message);
      setUpdatePhase('error');
    }
  };

  const runUpdate = async () => {
    setUpdateBusy(true);
    setUpdatePhase('installing');
    setUpdateError(null);
    try {
      const r = await api.post<{ ok: boolean; message: string }>('/api/admin/update/run');
      setUpdatePhase('restarting');
      toast.success(r.message || 'Update started — the gateway will restart shortly.');
      // The server exits to let its supervisor restart on the new version;
      // poll until it is back, then reload to pick up the new bundle.
      const poll = setInterval(() => {
        fetch('/health').then((r) => {
          if (r.ok) { clearInterval(poll); window.location.reload(); }
        }).catch(() => { /* still restarting */ });
      }, 3000);
      setTimeout(() => clearInterval(poll), 120_000);
    } catch (e) {
      toast.error((e as Error).message);
      setUpdateError((e as Error).message);
      setUpdatePhase('error');
    } finally {
      setUpdateBusy(false);
    }
  };
  // TOTP state
  const [totpState, setTotpState] = useState<'disabled' | 'enabled' | 'setup' | 'verifying' | 'showingRecovery'>('disabled');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpQr, setTotpQr] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpRecoveryCodes, setTotpRecoveryCodes] = useState<string[]>([]);
  const [totpDisablePassword, setTotpDisablePassword] = useState('');
  const [totpDisableCode, setTotpDisableCode] = useState('');
  const [totpRegenerating, setTotpRegenerating] = useState(false);
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);

  const reload = async () => {
    const r = await api.get<{ settings: Settings }>('/api/admin/settings');
    setS(r.settings);
    setIpAllowDraft(r.settings.adminIpAllow ?? '');
    setIpBlockDraft(r.settings.adminIpBlock ?? '');
    const si = await api.get<SysInfo>('/api/admin/settings/system');
    setSys(si);
    // Check TOTP status by fetching /api/admin/me
    try {
      const me = await api.get<{ totpEnabled: boolean }>('/api/admin/me');
      setTotpState(me.totpEnabled ? 'enabled' : 'disabled');
    } catch { /* ignore */ }
  };
  // Refresh shared notification prefs store after every settings reload.
  useEffect(() => { void loadNotificationPrefs(true); }, []);
  useEffect(() => { void reload(); void checkUpdate(); }, []);
  if (!s) return <div className="text-muted-foreground">Loading…</div>;
  const update = async (patch: Partial<Settings>) => {
    try { await api.patch('/api/admin/settings', patch); toast.success('Saved'); void reload(); }
    catch (e) { toast.error((e as Error).message); }
  };

  // TOTP handlers
  const beginTotp = async () => {
    try {
      const r = await api.post<{ secret: string; qr: string }>('/api/admin/account/totp/begin');
      setTotpSecret(r.secret);
      setTotpQr(r.qr);
      setTotpState('setup');
      toast.info('Scan the QR code with your authenticator app');
    } catch (e) { toast.error((e as Error).message); }
  };

  const verifyTotp = async () => {
    if (!totpCode || totpCode.length !== 6) { toast.error('Enter a 6-digit code'); return; }
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/admin/account/totp/verify', { code: totpCode });
      setTotpRecoveryCodes(r.recoveryCodes);
      setTotpState('showingRecovery');
      toast.success('TOTP enabled successfully');
    } catch (e) { toast.error((e as Error).message); }
  };

  const disableTotp = async () => {
    if (!totpDisablePassword) { toast.error('Enter your password'); return; }
    if (!totpDisableCode) { toast.error('Enter a TOTP code or recovery code'); return; }
    try {
      await api.post('/api/admin/account/totp/disable', { password: totpDisablePassword, totp: totpDisableCode });
      setTotpState('disabled');
      setTotpDisablePassword('');
      setTotpDisableCode('');
      toast.success('TOTP disabled');
      void reload();
    } catch (e) { toast.error((e as Error).message); }
  };

  const regenerateRecovery = async () => {
    setTotpRegenerating(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/admin/account/totp/recovery/regenerate', { password: totpDisablePassword, totp: totpDisableCode });
      setTotpRecoveryCodes(r.recoveryCodes);
      setTotpState('showingRecovery');
      toast.success('Recovery codes regenerated');
    } catch (e) { toast.error((e as Error).message); }
    setTotpRegenerating(false);
  };
  const defaultTab = searchParams.get('tab') || 'logging';
  return (
    <div>
      <PageHeader title="Settings" description="Logging, security, backup, and system info" />
      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="logging">Logging</TabsTrigger>
          <TabsTrigger value="access">Access Control</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="backup">Backup</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="logging">
          <Card>
            <CardHeader><CardTitle className="text-base">Logging policy</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label>Request-content logging</Label>
                <Select value={s.contentLogMode} onValueChange={(v) => update({ contentLogMode: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="metadata">Metadata only (default)</SelectItem>
                    <SelectItem value="prompt">Prompt (sanitized)</SelectItem>
                    <SelectItem value="prompt_and_response">Prompt + response (sanitized)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Retention (days)</Label>
                <Input type="number" min={1} max={3650} value={s.retentionDays} onChange={(e) => update({ retentionDays: Number(e.target.value) })} />
              </div>
              <div className="space-y-1">
                <Label>Database size limit (MB)</Label>
                <Input type="number" min={64} value={s.dbSizeLimitMb} onChange={(e) => update({ dbSizeLimitMb: Number(e.target.value) })} />
              </div>
              <div className="flex items-center gap-2 pt-2">
                <Button onClick={async () => { const r = await api.post<{ deletedRequests: number }>('/api/admin/settings/cleanup'); toast.success(`Deleted ${r.deletedRequests} old requests`); }}>Run cleanup now</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="access">
          <Card>
            <CardHeader><CardTitle className="text-base">IP access control</CardTitle><CardDescription>Allowlist / Blocklist for this admin website (not model traffic)</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Allow only these IPs</Label>
                <Textarea
                  placeholder="192.168.1.0/24&#10;10.0.0.1"
                  value={ipAllowDraft}
                  onChange={(e) => setIpAllowDraft(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Newlines-delimited CIDR ranges (IPv4 only). Leave empty = no allow restrictions. When you save a non-empty list, your current IP is auto-added to prevent lockout.</p>
              </div>
              <div className="space-y-2">
                <Label>Block these IPs</Label>
                <Textarea
                  placeholder="192.168.1.100"
                  value={ipBlockDraft}
                  onChange={(e) => setIpBlockDraft(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Newlines-delimited CIDR ranges (IPv4 only). Blocked IPs are rejected with &quot;Không có quyền truy cập&quot; before any login page.</p>
              </div>
              <Button onClick={() => {
                const patch: Record<string, unknown> = {};
                if (ipAllowDraft !== (s?.adminIpAllow ?? '')) patch.adminIpAllow = ipAllowDraft || null;
                if (ipBlockDraft !== (s?.adminIpBlock ?? '')) patch.adminIpBlock = ipBlockDraft || null;
                void api.patch<{ ok: boolean; addedIp?: string }>('/api/admin/settings', patch)
                  .then((r) => {
                    toast.success(`Saved` + (r.addedIp ? ` — added your IP: ${r.addedIp}` : ''));
                    reload();
                    setIpAllowDraft('');
                    setIpBlockDraft('');
                  })
                  .catch((e) => toast.error((e as Error).message));
              }}>Save access control</Button>
              <div className="rounded bg-amber-50 border border-amber-200 p-3 dark:bg-amber-950/20 dark:border-amber-800">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">⚠️ If you enable an allow list, you cannot access the gateway unless your IP matches.</p>
                <p className="text-xs text-amber-800 dark:text-amber-300">The server automatically adds your current IP when you save — but if you configure it from a different machine, that machine will be locked out immediately.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security">
          <Card>
            <CardHeader><CardTitle className="text-base">Security</CardTitle><CardDescription>Change password, 2FA, and trusted proxy configuration</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Trusted proxy hops</Label>
                <Input type="number" min={0} max={8} value={s.trustProxyHops} onChange={(e) => update({ trustProxyHops: Number(e.target.value) })} />
                <p className="text-xs text-muted-foreground">0 = never trust X-Forwarded-For (direct exposure). 1+ only when behind a single trusted reverse proxy.</p>
              </div>

              {/* TOTP 2FA */}
              <div className="space-y-2 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Label className="text-base">TOTP 2FA</Label>
                  {totpState === 'enabled' ? <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200">Enabled</span> : null}
                  {totpState === 'disabled' ? <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Disabled</span> : null}
                </div>

                {totpState === 'disabled' && (
                  <Button variant="outline" onClick={beginTotp}>Enable TOTP</Button>
                )}

                {totpState === 'setup' && (
                  <div className="space-y-3 rounded border p-3">
                    <p className="text-sm text-muted-foreground">Scan this QR code with your authenticator app, or enter the secret manually.</p>
                    {totpQr && <img src={totpQr} alt="TOTP QR code" className="h-40 w-40" />}
                    <div className="text-xs font-mono text-muted-foreground">Secret: {totpSecret}</div>
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Label>Verify code</Label>
                        <Input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="123456" maxLength={6} />
                      </div>
                      <Button disabled={totpCode.length < 6} onClick={verifyTotp}>Verify & enable</Button>
                    </div>
                  </div>
                )}

                {totpState === 'showingRecovery' && (
                  <div className="space-y-3 rounded border border-amber-500/40 bg-amber-50 p-3 dark:bg-amber-950/20">
                    <p className="text-sm font-medium">Recovery codes — save these now!</p>
                    <p className="text-xs text-muted-foreground">Each code can be used once to log in without your TOTP device. They will not be shown again.</p>
                    <div className="space-y-1">
                      {totpRecoveryCodes.map((c, i) => (
                        <div key={i} className="font-mono text-xs">{c}</div>
                      ))}
                    </div>
                    <Button onClick={() => { setTotpState('enabled'); toast.success('Recovery codes saved'); }}>I have saved them</Button>
                  </div>
                )}

                {totpState === 'enabled' && (
                  <div className="space-y-3 rounded border p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <Label>Password</Label>
                        <Input type="password" value={totpDisablePassword} onChange={(e) => setTotpDisablePassword(e.target.value)} placeholder="Current password" />
                      </div>
                      <div>
                        <Label>TOTP code</Label>
                        <Input value={totpDisableCode} onChange={(e) => setTotpDisableCode(e.target.value)} placeholder="123456" maxLength={6} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" disabled={totpRegenerating || !totpDisablePassword || totpDisableCode.length < 6} onClick={regenerateRecovery}>Regenerate recovery codes</Button>
                      <Button variant="destructive" size="sm" disabled={!totpDisablePassword || totpDisableCode.length < 6} onClick={disableTotp}>Disable TOTP</Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 border-t pt-4">
                <Label>Change password</Label>
                <Input type="password" placeholder="Current password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} />
                <Input type="password" placeholder="New password (12+ chars)" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} />
                <Button disabled={!passwords.current || passwords.next.length < 12} onClick={async () => {
                  try { await api.post('/api/admin/account/password', { currentPassword: passwords.current, newPassword: passwords.next }); toast.success('Password changed'); setPasswords({ current: '', next: '' }); }
                  catch (e) { toast.error((e as Error).message); }
                }}>Change password</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="backup">
          <Card>
            <CardHeader><CardTitle className="text-base">Backup & restore</CardTitle><CardDescription>Download a snapshot or restore from a previous backup</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <Button onClick={async () => {
                try {
                  const res = await fetch('/api/admin/backup/create', { method: 'POST', credentials: 'include' });
                  if (!res.ok) throw new Error('Backup failed');
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = 'latedev-backup.json'; a.click();
                  URL.revokeObjectURL(url);
                  toast.success('Backup downloaded');
                } catch (e) { toast.error((e as Error).message); }
              }}>Download backup</Button>
              <AlertDialog open={pendingRestoreFile !== null} onOpenChange={(o) => { if (!o) setPendingRestoreFile(null); }}>
                <AlertDialogTrigger asChild>
                  <div>
                    <Label>Restore from backup file</Label>
                    <Input type="file" accept=".json,application/json" data-testid="restore-file" onChange={(e) => {
                      const file = e.target.files?.[0];
                      setPendingRestoreFile(file ?? null);
                    }} />
                  </div>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Restore backup?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Restoring will replace the entire current database with the selected backup
                      ({pendingRestoreFile?.name ?? 'file'}). This cannot be undone. A snapshot of the current
                      database is kept for rollback only if validation fails.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={async () => {
                      const file = pendingRestoreFile;
                      if (!file) return;
                      try {
                        const res = await fetch('/api/admin/backup/restore', {
                          method: 'POST', body: file, credentials: 'include', headers: { 'content-type': 'application/json' },
                        });
                        if (!res.ok) throw new Error((await res.json())?.error?.message ?? 'Restore failed');
                        toast.success('Restored. Reloading…');
                        setPendingRestoreFile(null);
                        // Full reload: flush all cached React state so the
                        // refreshed UI reads from the restored database.
                        setTimeout(() => location.reload(), 600);
                      } catch (e) { toast.error((e as Error).message); }
                    }}>Restore</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="system">
          <Card>
            <CardHeader><CardTitle className="text-base">System</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div><span className="text-muted-foreground">App version:</span> {sys?.appVersion}</div>
              <div><span className="text-muted-foreground">Data directory:</span> <span className="font-mono">{sys?.dataDir}</span></div>
              <div><span className="text-muted-foreground">Encryption:</span> {sys?.masterKeyConfigured ? 'Configured' : 'Not configured'} (v{sys?.masterKeyVersion})</div>
              <div><span className="text-muted-foreground">Environment:</span> {sys?.environment}</div>
              <div className="flex items-center gap-2 pt-2">
                <Switch checked={s.gatewayCacheEnabled} onCheckedChange={(v) => update({ gatewayCacheEnabled: v })} />
                <Label>Gateway response cache (disabled by default)</Label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Cache TTL (s)</Label><Input type="number" min={1} value={s.gatewayCacheDefaultTtlSeconds} onChange={(e) => update({ gatewayCacheDefaultTtlSeconds: Number(e.target.value) })} /></div>
                <div><Label>Cache max size (MB)</Label><Input type="number" min={1} value={s.gatewayCacheMaxSizeMb} onChange={(e) => update({ gatewayCacheMaxSizeMb: Number(e.target.value) })} /></div>
              </div>
              <Button variant="outline" onClick={async () => { const r = await api.post<{ deleted: number }>('/api/admin/settings/cache/clear'); toast.success(`Cleared ${r.deleted} entries`); }}>Clear gateway cache</Button>
            </CardContent>
          </Card>

          <NotificationsCard />

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-base">Updates</CardTitle>
              <CardDescription>Automatic updates from the npm registry</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {updatePhase === 'checking' && !updateInfo && (
                <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking for updates…</div>
              )}
              {updateInfo && (
                <>
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground">Current version</div>
                      <div className="font-mono">v{updateInfo.currentVersion}</div>
                    </div>
                    <span className="text-muted-foreground">→</span>
                    <div>
                      <div className="text-xs text-muted-foreground">Latest version</div>
                      <div className="font-mono">{updateInfo.latestVersion ? `v${updateInfo.latestVersion}` : '—'}</div>
                    </div>
                    {updateInfo.status.docker ? (
                      <Badge variant="secondary">{updateInfo.status.watchtower ? 'Docker + Watchtower' : 'Docker'}</Badge>
                    ) : updateInfo.latestVersion === null ? (
                      <Badge variant="secondary">Registry unreachable</Badge>
                    ) : updateInfo.hasUpdate ? (
                      <Badge variant="success">Update available</Badge>
                    ) : (
                      <Badge variant="outline"><CheckCircle2 className="mr-1 h-3 w-3" /> Up to date</Badge>
                    )}
                  </div>

                  {updateInfo.status.docker && updateInfo.status.watchtower && updateInfo.watchtowerReachable && (
                    <p className="text-muted-foreground">Watchtower pulls new images automatically every hour — or use Update now for an instant update.</p>
                  )}
                  {updateInfo.status.docker && updateInfo.status.watchtower && updateInfo.watchtowerReachable === false && (
                    <p className="text-muted-foreground">The Watchtower sidecar is configured but not running — start it with <code className="rounded bg-muted px-1 text-xs">docker compose --profile updater up -d</code>.</p>
                  )}
                  {updateInfo.status.docker && !updateInfo.status.watchtower && (
                    <p className="text-muted-foreground">{updateInfo.status.reason ?? 'This instance runs in Docker — update by pulling the new image tag.'}</p>
                  )}
                  {!updateInfo.status.docker && updateInfo.latestVersion === null && (
                    <p className="text-muted-foreground">Could not reach the npm registry (offline or blocked). {updateError && <span className="text-destructive">{updateError}</span>}</p>
                  )}

                  {updatePhase === 'installing' && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Applying the update… this can take a minute.</div>}
                  {updatePhase === 'restarting' && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Update applied — the gateway is restarting on the new version. This page reloads automatically.</div>}

                  <div className="flex flex-wrap items-center gap-2">
                    {updateInfo.hasUpdate && updatePhase === 'idle' && (!updateInfo.status.docker || (updateInfo.status.watchtower && updateInfo.watchtowerReachable !== false)) && (
                      <Button disabled={updateBusy || (updateInfo.status.docker && updateInfo.watchtowerReachable === false)} onClick={runUpdate}><Download className="mr-1 h-4 w-4" /> Update now</Button>
                    )}
                    {updateInfo.hasUpdate && updateInfo.changelogUrl && (
                      <Button variant="outline" asChild><a href={updateInfo.changelogUrl} target="_blank" rel="noreferrer">View changes</a></Button>
                    )}
                    {updatePhase === 'idle' && (
                      <Button variant="ghost" disabled={updateBusy} onClick={() => checkUpdate(true)}>Check again</Button>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Notification toggles card — lives in System tab. Shared prefs with useRequestNotifications.
function NotificationsCard() {
  const prefs = useNotificationPrefs();
  return (
    <Card className="mt-4">
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4" /> Notifications</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span>Show request notifications</span>
          <Switch checked={prefs.enabled} onCheckedChange={(v) => void saveNotificationPrefs({ enabled: v })} />
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1"><Volume2 className="h-3 w-3" /> Play notification sound</span>
          <Switch checked={prefs.sound} onCheckedChange={(v) => void saveNotificationPrefs({ sound: v })} />
        </div>
        <p className="text-xs text-muted-foreground mt-2">Notifications are disabled while muted. Changes apply immediately.</p>
      </CardContent>
    </Card>
  );
}
