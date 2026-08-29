import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { Button } from '../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '../../components/ui/alert-dialog';
import { api } from '../../lib/api';
import { toast } from 'sonner';

interface Settings {
  setupComplete: boolean; retentionDays: number; contentLogMode: string; dbSizeLimitMb: number;
  trustProxyHops: number; gatewayCacheEnabled: boolean; gatewayCacheDefaultTtlSeconds: number;
  gatewayCacheMaxSizeMb: number; masterKeyConfigured: boolean; masterKeyVersion: number;
}

interface SysInfo { appVersion: string; dataDir: string; masterKeyConfigured: boolean; masterKeyVersion: number; environment: string; }

export function Settings() {
  const [s, setS] = useState<Settings | null>(null);
  const [sys, setSys] = useState<SysInfo | null>(null);
  const [passwords, setPasswords] = useState({ current: '', next: '' });
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
    const si = await api.get<SysInfo>('/api/admin/settings/system');
    setSys(si);
    // Check TOTP status by fetching /api/admin/me
    try {
      const me = await api.get<{ totpEnabled: boolean }>('/api/admin/me');
      setTotpState(me.totpEnabled ? 'enabled' : 'disabled');
    } catch { /* ignore */ }
  };
  useEffect(() => { void reload(); }, []);
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
  return (
    <div>
      <PageHeader title="Settings" description="Logging, security, backup, and system info" />
      <Tabs defaultValue="logging">
        <TabsList>
          <TabsTrigger value="logging">Logging</TabsTrigger>
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
                        toast.success('Restored. Please restart the gateway.');
                        setPendingRestoreFile(null);
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
