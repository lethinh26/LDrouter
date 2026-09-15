// Connect OpenAI Codex: opens the Codex CLI PKCE authorize URL, then finishes either from the
// browser's loopback redirect or a pasted callback URL.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from 'sonner';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

/** The Codex CLI registers this exact loopback redirect, so the port is fixed. */
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const REDIRECT_PORT = '1455';
/** Server route the browser's loopback redirect has to reach for auto-capture to work. */
const LOOPBACK_HINT = 'http://localhost:8791/oauth/codex/callback';

export function CodexOAuthDialog({ providerId, providerName, open, onOpenChange, onConnected }: {
  providerId: string; providerName: string; open: boolean; onOpenChange: (open: boolean) => void; onConnected: () => void;
}) {
  const [state, setState] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [awaitingPaste, setAwaitingPaste] = useState(false);

  const start = useCallback(async () => {
    setLoading(true); setError(''); setCallbackUrl('');
    try {
      const result = await api.post<{ state: string; authorizeUrl: string }>('/api/admin/codex/oauth/start', { providerId });
      setState(result.state); setAuthorizeUrl(result.authorizeUrl);
    } catch (e) { setError((e as Error).message || 'Unable to start the Codex authorization flow'); }
    finally { setLoading(false); }
  }, [providerId]);
  useEffect(() => { void start(); }, [start]);

  // Poll the session: when the loopback callback has captured the code, only the paste-free
  // Connect path is still needed to run the exchange.
  useEffect(() => {
    if (!state) return;
    const timer = setInterval(() => {
      void api.get<{ callbackReceived?: boolean }>(`/api/admin/codex/oauth/${state}`)
        .then((result) => setAwaitingPaste(!result?.callbackReceived))
        .catch(() => setAwaitingPaste(true));
    }, 5000);
    return () => clearInterval(timer);
  }, [state]);

  const complete = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.post<{ status: string }>('/api/admin/codex/oauth/complete', { providerId, state, callbackUrl });
      toast.success(`Codex account ${result.status === 'added' ? 'connected' : 'updated'}`);
      onOpenChange(false);
      onConnected();
    } catch (e) { setError((e as Error).message || 'Unable to complete the Codex authorization'); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(authorizeUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setError('Clipboard is unavailable — select the URL and copy it manually.'); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect OpenAI Codex</DialogTitle>
          <DialogDescription>Authorize a ChatGPT account for {providerName}. The callback is captured on localhost:{REDIRECT_PORT} — nothing is sent anywhere else.</DialogDescription>
        </DialogHeader>

        {loading ? <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Starting authorization…</p> : (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for popup authorization…
            </p>
            <p className="text-xs text-muted-foreground">
              The browser will try to hand the callback to <code className="font-mono">{LOOPBACK_HINT}</code>. Most browsers block that from a public origin —
              if the page fails to load, copy the address bar and paste it in step 2.
            </p>

            <div className="space-y-2">
              <Label>Step 1: Open this URL in your browser</Label>
              <div className="flex gap-2">
                <Input readOnly className="font-mono text-xs" value={authorizeUrl} onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" aria-label="Copy authorization URL" onClick={() => void copy()}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button>
                <Button type="button" variant="outline" aria-label="Open authorization URL" asChild><a href={authorizeUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a></Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="codex-callback">Step 2: Paste the callback URL here</Label>
              <p className="text-xs text-muted-foreground">After authorization, copy the full URL from your browser — or just the authorization code.</p>
              <Input id="codex-callback" value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} placeholder={`${REDIRECT_URI}?code=…`} />
              <p className="text-xs text-muted-foreground">Or paste callback URL manually</p>
            </div>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || loading || (awaitingPaste && !callbackUrl.trim())} onClick={() => void complete()}>{busy ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Connecting…</> : 'Connect'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
