// Setup page: first-run admin creation.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
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
          <div className="space-y-1">
            <Label>Master encryption key (optional, 32+ chars)</Label>
            <Input value={masterKey} onChange={(e) => setMasterKey(e.target.value)} placeholder="Auto-generated if empty" />
            <p className="text-xs text-muted-foreground">Once set, provider credentials will be encrypted with this key. Save it somewhere safe.</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button disabled={submitting || password.length < 12} onClick={async () => {
            setSubmitting(true);
            try {
              await api.post('/api/admin/setup', { username, password, setupMasterKey: masterKey || undefined });
              toast.success('Admin account created');
              navigate('/login', { replace: true });
              window.location.reload();
            } catch (e) {
              toast.error((e as Error).message);
            } finally { setSubmitting(false); }
          }}>Create admin</Button>
        </CardFooter>
      </Card>
    </div>
  );
}
