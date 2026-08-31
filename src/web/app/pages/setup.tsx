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
        <CardFooter>
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
        </CardFooter>
      </Card>
    </div>
  );
}
