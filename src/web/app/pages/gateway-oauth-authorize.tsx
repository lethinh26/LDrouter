import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { api } from '../../lib/api';
import { gatewayConsentKeyReason, parseGatewayAuthorization, validatedGatewayCallback, type GatewayConsentKey } from '../../lib/gateway-oauth';

export function GatewayOAuthAuthorize() {
  const { search } = useLocation();
  // A different authorization request must never inherit a previous selection
  // or receive the previous request's asynchronously returned callback.
  return <GatewayOAuthConsent key={search} search={search} onRedirect={url => window.location.replace(url)} />;
}

export function GatewayOAuthConsent({ search, onRedirect }: { search: string; onRedirect: (url: string) => void }) {
  const request = parseGatewayAuthorization(search);
  const [keys, setKeys] = useState<GatewayConsentKey[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(false);
  const locked = useRef(false);
  const valid = request !== null;

  useEffect(() => {
    live.current = true;
    if (valid) {
      // The dedicated endpoint returns metadata only, never API key secrets.
      void api.get<{ keys: GatewayConsentKey[] }>('/api/admin/gateway-oauth/keys').then(result => {
        if (!live.current) return;
        setKeys(result.keys.map(k => ({
          id: k.id, name: k.name, keyPrefix: k.keyPrefix, enabled: k.enabled, expiresAt: k.expiresAt,
          allowAllModels: k.allowAllModels, modelCount: k.modelCount,
          tpmLimit: k.tpmLimit, dailyTokenLimit: k.dailyTokenLimit,
          monthlyTokenLimit: k.monthlyTokenLimit, totalTokenLimit: k.totalTokenLimit,
          maxOutputTokensPerRequest: k.maxOutputTokensPerRequest,
        })));
      }).catch(() => { if (live.current) setLoadError(true); })
        .finally(() => { if (live.current) setLoading(false); });
    } else setLoading(false);
    return () => { live.current = false; };
  }, [valid]);

  const selected = keys.find(key => key.id === selectedId);
  const selectedUsable = !!selected && gatewayConsentKeyReason(selected) === null;
  async function authorize() {
    if (!request || !selected || gatewayConsentKeyReason(selected) !== null || loading || loadError || locked.current) return;
    // No automatic retry or repeated consent issuance. A failed or malformed
    // response requires restarting from the original client.
    locked.current = true;
    setSubmitting(true);
    setSubmitted(true);
    setError('');
    try {
      const result = await api.post<{ redirectUrl: string }>('/api/admin/gateway-oauth/authorize', { ...request, apiKeyId: selected.id });
      if (!live.current) return;
      const callback = validatedGatewayCallback(result.redirectUrl, request.state);
      if (!callback) {
        setError('The authorization response could not be verified. No redirect was performed. Restart the gateway sign-in from Codex.');
        return;
      }
      onRedirect(callback);
    } catch {
      if (live.current) setError('Authorization failed. No redirect was performed. Restart the gateway sign-in from Codex.');
    } finally {
      if (live.current) setSubmitting(false);
    }
  }

  return <div className="mx-auto max-w-2xl">
    <Card>
      <CardHeader>
        <div className="mb-2 flex items-center gap-3"><div className="rounded-lg border bg-muted p-2"><ShieldCheck className="h-6 w-6" /></div><Badge variant="outline">Gateway OAuth</Badge></div>
        <CardTitle>Authorize Codex gateway access</CardTitle>
        <CardDescription>Grant the local Codex client access to this LateDev Router instance using an existing gateway API key.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!request ? <>
          <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">Invalid authorization request. Start a new gateway sign-in from the configured Codex client. No access will be granted.</p>
          <Button asChild variant="outline"><Link to="/providers">Return to Providers</Link></Button>
        </> : <>
          <div className="space-y-2 rounded-md border p-4 text-sm">
            <p className="font-medium">What you are authorizing</p>
            <p>The fixed LDrouter Codex client (<code>ldrouter-codex</code>) will receive a short-lived gateway access token and a renewable grant bound to the selected key. Existing model permissions, limits and revocation rules still apply.</p>
            <p className="text-muted-foreground">Access is limited to native Codex gateway routes. This does not sign in to ChatGPT or grant access to an OpenAI subscription. Upstream Codex sign-in is separate and remains inside the client.</p>
            <p className="text-xs text-muted-foreground">The callback returns only to <code>http://127.0.0.1:43127/callback</code> on your computer. Continue only if you initiated this request from your Codex client.</p>
          </div>
          <fieldset disabled={loading || submitting || submitted || loadError} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Select an existing API key</legend>
            {loading ? <p role="status" className="text-sm text-muted-foreground">Loading API keys…</p>
              : loadError ? <p role="alert" className="text-sm text-destructive">Unable to load API keys. Restart the gateway sign-in.</p>
                : keys.length === 0 ? <p className="text-sm text-muted-foreground">No API keys are configured. Create a scoped key first, then restart the gateway sign-in.</p>
                  : keys.map(key => {
                    const reason = gatewayConsentKeyReason(key);
                    return <label key={key.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed">
                      <input type="radio" name="gateway-consent-key" className="mt-1 accent-primary" value={key.id} checked={selectedId === key.id} disabled={reason !== null} onChange={() => setSelectedId(key.id)} />
                      <span className="min-w-0 flex-1 space-y-1"><span className="block break-all text-sm font-medium">{key.name}</span>
                        <span className="block text-xs text-muted-foreground">{key.keyPrefix ? key.keyPrefix + '… · ' : ''}{key.allowAllModels ? 'All model routes' : key.modelCount + ' model permissions'} · {key.expiresAt ? 'Key expiry: ' + new Date(key.expiresAt).toLocaleString() : 'No key expiry'}</span>
                        {reason && <span className="block text-xs text-muted-foreground">{reason}</span>}
                      </span>
                    </label>;
                  })}
          </fieldset>
          <p className="text-xs text-muted-foreground">Use an uncapped, least-privilege key scoped to your intended native Codex routes. Selecting a key does not establish upstream model availability. Grants can be revoked in Providers.</p>
          {error && <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="outline"><Link to="/providers">Cancel</Link></Button>
            <Button disabled={loading || loadError || submitted || submitting || !selectedUsable} onClick={() => void authorize()}>{submitting ? 'Authorizing…' : 'Authorize gateway access'}</Button>
          </div>
        </>}
      </CardContent>
    </Card>
  </div>;
}
