// Login page.
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { useAuth } from '../auth';
import { toast } from 'sonner';

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [recovery, setRecovery] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="LateDev Router" className="h-8 w-8 object-contain" />
            <CardTitle>Sign in</CardTitle>
          </div>
          <CardDescription>Enter your admin credentials.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Username</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {needsTotp && (
            <>
              <div className="space-y-1">
                <Label>2FA code (or recovery code)</Label>
                <Input value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="123456" maxLength={6} />
              </div>
              <div className="space-y-1">
                <Label>Recovery code (alternative)</Label>
                <Input value={recovery} onChange={(e) => setRecovery(e.target.value)} placeholder="ABCD12-EF3456" />
              </div>
            </>
          )}
        </CardContent>
        <div className="px-6 pb-6">
          <Button className="w-full" disabled={submitting} onClick={async () => {
            setSubmitting(true);
            try {
              const r = await login(username, password, totp || undefined, recovery || undefined);
              if (r.totpRequired) { setNeedsTotp(true); return; }
              const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';
              navigate(from, { replace: true });
            } catch (e) {
              toast.error((e as Error).message);
            } finally { setSubmitting(false); }
          }}>Sign in</Button>
        </div>
      </Card>
    </div>
  );
}
