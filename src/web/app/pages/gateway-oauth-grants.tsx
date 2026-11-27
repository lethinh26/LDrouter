import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { api } from '../../lib/api';

export interface GatewayOAuthGrant {
  id: string;
  apiKeyId: string;
  apiKeyName: string | null;
  createdAt: string;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  absoluteExpiresAt: string | null;
  lastRefreshedAt: string | null;
  status: string;
}

function dateLabel(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString();
}

export function GatewayOAuthGrants() {
  const [grants, setGrants] = useState<GatewayOAuthGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const sequence = useRef(0);
  const revokeLock = useRef(false);

  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await api.get<{ grants: GatewayOAuthGrant[] }>('/api/admin/gateway-oauth/grants');
      if (current !== sequence.current) return;
      // Metadata only: never store an entire arbitrary response or a credential.
      setGrants(result.grants.map(g => ({
        id: g.id, apiKeyId: g.apiKeyId, apiKeyName: g.apiKeyName, createdAt: g.createdAt,
        accessExpiresAt: g.accessExpiresAt, refreshExpiresAt: g.refreshExpiresAt,
        absoluteExpiresAt: g.absoluteExpiresAt, lastRefreshedAt: g.lastRefreshedAt, status: g.status,
      })));
    } catch {
      if (current === sequence.current) setFailed(true);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); return () => { sequence.current = sequence.current + 1; }; }, [reload]);

  async function revoke() {
    if (!revokeId || revokeLock.current) return;
    revokeLock.current = true;
    setRevoking(true);
    try {
      await api.del('/api/admin/gateway-oauth/grants/' + encodeURIComponent(revokeId));
      setRevokeId(null);
      toast.success('Gateway OAuth grant revoked');
      await reload();
    } catch {
      toast.error('Unable to revoke the grant. Refresh and try again.');
    } finally {
      revokeLock.current = false;
      setRevoking(false);
    }
  }

  return <Card aria-label="Gateway OAuth grants">
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />Gateway OAuth grants</CardTitle>
          <CardDescription>LDrouter-issued authorization for the fixed Codex client, separate from upstream account sign-in.</CardDescription>
        </div>
        <Button variant="outline" size="sm" disabled={loading || revoking} onClick={() => void reload()}><RefreshCw className="mr-1 h-4 w-4" />Refresh grants</Button>
      </div>
    </CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">Start gateway sign-in from a Codex client configured with Gateway OAuth. After admin login, select an existing key and approve its access. Only native Codex gateway routes are authorized; upstream account credentials remain separate.</p>
      <p className="text-xs text-muted-foreground">Revoking a grant invalidates its access and refresh tokens without deleting the backing API key, its models, or any upstream account. Key permissions and limits still apply.</p>
      {loading ? <p role="status" className="text-sm text-muted-foreground">Loading grants…</p>
        : failed ? <p role="alert" className="text-sm text-destructive">Unable to load gateway grants. Refresh to retry.</p>
          : <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>API key</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead>Access expires</TableHead><TableHead>Refresh expires</TableHead><TableHead>Absolute expiry</TableHead><TableHead>Last refreshed</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {grants.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">No gateway OAuth grants.</TableCell></TableRow>}
                {grants.map(g => <TableRow key={g.id}>
                  <TableCell className="font-medium">{g.apiKeyName || 'Unavailable key'}<div className="break-all text-xs text-muted-foreground">{g.id}</div></TableCell>
                  <TableCell><Badge variant={g.status === 'active' ? 'success' : 'outline'}>{g.status}</Badge></TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{dateLabel(g.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{dateLabel(g.accessExpiresAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{dateLabel(g.refreshExpiresAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{dateLabel(g.absoluteExpiresAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{dateLabel(g.lastRefreshedAt)}</TableCell>
                  <TableCell className="text-right"><Button variant="outline" size="sm" disabled={revoking || g.status === 'revoked'} aria-label={'Revoke grant ' + g.id} onClick={() => setRevokeId(g.id)}>Revoke</Button></TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </div>}
    </CardContent>
    <AlertDialog open={revokeId !== null} onOpenChange={open => { if (!open && !revoking) setRevokeId(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Revoke gateway OAuth grant?</AlertDialogTitle><AlertDialogDescription>This client grant will no longer be able to authenticate to LDrouter, including with its refresh token. The backing API key and upstream account are unchanged.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={revoking} onClick={event => { event.preventDefault(); void revoke(); }}>{revoking ? 'Revoking…' : 'Revoke grant'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
