// Setup page: first-run admin creation. The master encryption key is REQUIRED
// (unless already configured via LATEDEV_MASTER_KEY) — provider credentials are
// encrypted with it, so the admin must keep a copy.
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { api } from '../../lib/api';
import { toast } from 'sonner';

export function Setup() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [masterKey, setMasterKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // true = master key must be entered on this form; false = already configured
  // via LATEDEV_MASTER_KEY (field hidden).
  const [masterKeyRequired, setMasterKeyRequired] = useState(true);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    api.get<{ masterKeyConfigured: boolean }>('/api/admin/setup/status')
      .then((s) => setMasterKeyRequired(!s.masterKeyConfigured))
      .catch(() => setMasterKeyRequired(true));
  }, []);

  const keyOk = !masterKeyRequired || masterKey.trim().length >= 32;
  const canSubmit = !submitting && password.length >= 12 && keyOk;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="LateDev Router" className="h-8 w-8 object-contain rounded" />
            <CardTitle>Welcome to LateDev Router</CardTitle>
          </div>
          <CardDescription>Set up the administrator account to get started.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Username</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Password (12+ chars)</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {masterKeyRequired && (
            <div className="space-y-1">
              <Label>Master encryption key (required, 32+ chars)</Label>
              <Input type="password" value={masterKey} onChange={(e) => setMasterKey(e.target.value)} placeholder="Paste or generate a 32+ character key" />
              <p className="text-xs text-muted-foreground">
                Provider API keys are encrypted with this key (AES-256-GCM). Store it somewhere safe —
                if it is lost, stored provider credentials cannot be recovered.
                Generate one with:{' '}
                <code className="break-all">{'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'}</code>
              </p>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-4">
          <Button disabled={!canSubmit} onClick={async () => {
            setSubmitting(true);
            try {
              await api.post('/api/admin/setup', { username, password, setupMasterKey: masterKeyRequired ? masterKey.trim() : undefined });
              toast.success('Admin account created');
              // Hard reload, not router navigate: SetupGate cached setupComplete=false on mount and
              // would bounce a soft navigate('/login') straight back to /setup. A full page load
              // remounts the app, refetches setupComplete=true, and lands on /login cleanly.
              window.location.assign('/login');
            } catch (e) {
              toast.error((e as Error).message);
            } finally { setSubmitting(false); }
          }}>Create admin</Button>
          <div className="border-t pt-4 space-y-2">
            <Label>Import existing database</Label>
            <p className="text-xs text-muted-foreground">Use this to restore the administrator account, password, TOTP settings, providers, models, and master key from a backup without setting up again. Enter the same 6-digit backup passphrase used when the file was created.</p>
            <Input type="file" accept=".json,application/json" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
            <Input inputMode="numeric" maxLength={6} value={importPassphrase} onChange={(e) => setImportPassphrase(e.target.value.replace(/\D/g, ''))} placeholder="Backup passphrase (6 digits)" />
            <Button variant="outline" disabled={!importFile || importPassphrase.length !== 6 || importing} onClick={async () => {
              if (!importFile) return;
              setImporting(true);
              try {
                const backup = JSON.parse(await importFile.text());
                const res = await fetch('/api/admin/backup/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backup, passphrase: importPassphrase }) });
                if (!res.ok) throw new Error((await res.json())?.error?.message ?? 'Import failed');
                toast.success('Database imported');
                window.location.assign('/login');
              } catch (e) { toast.error((e as Error).message); }
              finally { setImporting(false); }
            }}>Import database</Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
