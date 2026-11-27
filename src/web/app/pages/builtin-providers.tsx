import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Code2, Copy, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../components/ui/alert-dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { api } from '../../lib/api';
import { GATEWAY_OAUTH_CLIENT_ID, GATEWAY_OAUTH_PATH, GATEWAY_OAUTH_REDIRECT_PORT } from '../../lib/gateway-oauth';
import { GatewayOAuthGrants } from './gateway-oauth-grants';

export type BuiltinKind = 'codex' | 'claude_code';
export interface BuiltinConnection {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  health: string;
  modelCount: number;
  namespaceMode: 'legacy' | 'canonical';
  authMode: 'client_oauth' | 'api_key';
  createdAt: string;
  updatedAt: string;
  usage: { requests: number; totalTokens: number };
}
export interface BuiltinProvider {
  kind: BuiltinKind;
  name: string;
  slug: 'cx' | 'cc';
  authMode: BuiltinConnection['authMode'];
  namespaceAvailable: boolean;
  conflicts: string[];
  connections: BuiltinConnection[];
}

/** A backing connection slug is not necessarily its public model namespace. */
export function builtinModelPrefix(provider: BuiltinProvider, connection: BuiltinConnection): string {
  return connection.namespaceMode === 'canonical' ? provider.slug : connection.slug;
}

export function builtinClientConfiguration(kind: BuiltinKind, prefix: string, origin: string): string {
  if (kind === 'codex') {
    return `model_provider = "latedev-codex"\nmodel = "${prefix}/YOUR_IMPORTED_MODEL"\n\n[model_providers.latedev-codex]\nname = "LateDev Codex"\nbase_url = "${origin}/backend-api/codex"\nmodel_catalog_url = "${origin}/backend-api/codex/models"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nenv_http_headers = { "X-API-Key" = "LATEDEV_API_KEY" }`;
  }
  return `ANTHROPIC_BASE_URL=${origin}\nANTHROPIC_AUTH_TOKEN=YOUR_GATEWAY_API_KEY\nANTHROPIC_MODEL=${prefix}/YOUR_IMPORTED_MODEL`;
}

/** Gateway OAuth supplies a distinct gateway credential, not the upstream bearer. */
export function codexGatewayOAuthConfiguration(prefix: string, origin: string): string {
  return [
    'model_provider = "latedev-codex"',
    `model = "${prefix}/YOUR_IMPORTED_MODEL"`,
    '',
    '[model_providers.latedev-codex]',
    'name = "LateDev Codex"',
    `base_url = "${origin}/backend-api/codex"`,
    `model_catalog_url = "${origin}/backend-api/codex/models"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
    '',
    '[model_providers.latedev-codex.gateway_oauth]',
    `client_id = "${GATEWAY_OAUTH_CLIENT_ID}"`,
    `authorization_url = "${origin}${GATEWAY_OAUTH_PATH}"`,
    `token_url = "${origin}/api/oauth/token"`,
    `redirect_port = ${GATEWAY_OAUTH_REDIRECT_PORT}`,
    'delivery = { kind = "header", name = "X-Gateway-Token", scheme = "Bearer" }',
  ].join('\n');
}

export function canCreateBuiltinConnection(provider: BuiltinProvider): boolean {
  // Existing legacy profiles stay addressable without consuming the single
  // canonical profile slot. A disabled canonical profile still occupies it.
  return provider.namespaceAvailable && (provider.kind === 'claude_code' || !provider.connections.some(c => c.namespaceMode === 'canonical'));
}

function description(kind: BuiltinKind) {
  return kind === 'codex'
    ? 'One canonical profile for native Codex Responses. Existing legacy profiles retain their model prefixes. Upstream account sign-in remains inside Codex; LDrouter gateway authorization is separate.'
    : 'Connect authorized Anthropic API keys for Claude Code. Models are pinned to a connection; there is no automatic credential rotation.';
}

function NamespaceNotice({ provider }: { provider: BuiltinProvider }) {
  if (provider.namespaceAvailable && provider.conflicts.length === 0) return null;
  return <div role="alert" className="rounded-md border border-amber-500/50 p-3 text-sm text-amber-700 dark:text-amber-300">
    <p className="font-medium">Canonical namespace: <code>{provider.slug}/</code> {provider.namespaceAvailable ? '— conflicts reported' : 'is unavailable'}</p>
    {provider.conflicts.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-5">{provider.conflicts.map((conflict, i) => <li key={i} className="break-all">{conflict}</li>)}</ul>}
    <p className="mt-1 text-xs">Existing connections keep their saved model prefixes. No automatic rename or migration is performed.</p>
  </div>;
}

function ConnectionStatus({ provider, connection }: { provider: BuiltinProvider; connection: BuiltinConnection }) {
  if (!connection.enabled) return <Badge variant="secondary">Disabled</Badge>;
  if (provider.kind === 'codex') return <Badge variant="outline">Client account unverified</Badge>;
  return <Badge variant={connection.health === 'healthy' ? 'success' : connection.health === 'down' ? 'destructive' : 'secondary'}>{connection.health}</Badge>;
}

function Prefix({ provider, connection }: { provider: BuiltinProvider; connection: BuiltinConnection }) {
  return <div className="flex flex-wrap items-center gap-1.5">
    <code className="text-xs">{builtinModelPrefix(provider, connection)}/</code>
    <Badge variant="outline">{connection.namespaceMode === 'canonical' ? 'Canonical' : 'Legacy'}</Badge>
  </div>;
}

export function BuiltinProviders({ revision }: { revision: number }) {
  const [providers, setProviders] = useState<BuiltinProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedKind, setSelectedKind] = useState<BuiltinKind | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [busy, setBusy] = useState<'create' | 'rename' | 'toggle' | 'test' | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const requestSequence = useRef(0);
  const provider = providers.find((p) => p.kind === selectedKind);
  const connection = provider?.connections.find((c) => c.id === connectionId);
  const unavailable = loading || !!loadError || busy !== null || modelBusy;

  const reload = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.get<{ providers: BuiltinProvider[] }>('/api/admin/builtin-providers');
      if (sequence === requestSequence.current) setProviders(result.providers);
    } catch (error) {
      if (sequence === requestSequence.current) setLoadError((error as Error).message || 'Unable to load built-in providers');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload, revision]);

  function clearCreate() {
    setCreateOpen(false);
    setNewName('');
    setNewApiKey('');
  }

  function openConnection(c: BuiltinConnection) {
    setConnectionId(c.id);
    setEditingName(c.name);
  }

  async function createConnection() {
    if (!provider || unavailable || !canCreateBuiltinConnection(provider) || !newName.trim()) return;
    if (provider.kind === 'claude_code' && !/^sk-ant-api[A-Za-z0-9_-]+$/.test(newApiKey.trim())) return;
    const name = newName.trim();
    setBusy('create');
    try {
      const created = await api.post<{ id: string; slug: string }>(`/api/admin/builtin-providers/${provider.kind}/connections`, {
        name,
        ...(provider.kind === 'claude_code' ? { apiKey: newApiKey.trim() } : {}),
      });
      clearCreate();
      setEditingName(name);
      setConnectionId(created.id);
      toast.success(provider.kind === 'codex' ? 'Codex profile created' : 'Connection created');
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
      // A conflict or simultaneous creation can change eligibility.
      await reload();
    } finally { setBusy(null); }
  }

  async function saveName() {
    if (!connection || unavailable || !editingName.trim() || editingName.trim() === connection.name) return;
    setBusy('rename');
    try {
      await api.patch('/api/admin/providers', { id: connection.id, name: editingName.trim() });
      toast.success('Connection renamed');
      await reload();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(null); }
  }

  async function setEnabled(enabled: boolean) {
    if (!connection || unavailable || connection.enabled === enabled) return;
    setBusy('toggle');
    try {
      await api.patch('/api/admin/providers', { id: connection.id, enabled });
      toast.success(enabled ? 'Connection enabled' : 'Connection disabled');
      setConfirmDisable(false);
      await reload();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(null); }
  }

  async function testConnection() {
    if (!connection || provider?.kind !== 'claude_code' || !connection.enabled || unavailable) return;
    setBusy('test');
    try {
      const result = await api.post<{ ok: boolean; detail: string }>(`/api/admin/providers/${connection.id}/test`);
      if (result.ok) toast.success(`Connection OK: ${result.detail}`);
      else toast.error(`Failed: ${result.detail}`);
      await reload();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(null); }
  }

  const config = provider && connection ? builtinClientConfiguration(provider.kind, builtinModelPrefix(provider, connection), window.location.origin) : '';
  const gatewayOAuthConfig = provider?.kind === 'codex' && connection ? codexGatewayOAuthConfiguration(builtinModelPrefix(provider, connection), window.location.origin) : '';

  return <section aria-label="Built-in Providers" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold tracking-tight">Built-in Providers</h2><p className="text-sm text-muted-foreground">First-class client integrations and their backing connections.</p></div>
      <Button variant="outline" size="sm" disabled={loading || busy !== null || modelBusy} onClick={() => void reload()}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh</Button>
    </div>
    {loadError ? <div role="alert" className="flex items-center justify-between gap-3 rounded-md border p-4 text-sm text-destructive">{loadError}<Button variant="outline" size="sm" onClick={() => void reload()}>Retry</Button></div>
      : loading && providers.length === 0 ? <p role="status" className="rounded-md border p-4 text-sm text-muted-foreground">Loading built-in providers…</p>
      : !provider ? <div className="grid gap-4 md:grid-cols-2">
        {providers.map((p) => <Card key={p.kind}>
          <CardHeader className="pb-3">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border bg-muted p-2">{p.kind === 'codex' ? <Code2 className="h-5 w-5" /> : <KeyRound className="h-5 w-5" />}</div>
              <div className="min-w-0 flex-1 space-y-1">
                <CardTitle className="text-base">{p.name}</CardTitle>
                <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{p.authMode === 'client_oauth' ? 'Client sign-in' : 'API key'}</Badge><code className="text-xs text-muted-foreground">{p.slug}/</code></div>
              </div>
            </div>
            <CardDescription>{description(p.kind)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <NamespaceNotice provider={p} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{p.connections.length} {p.kind === 'codex' ? 'profile' : 'connections'} · {p.connections.filter((c) => c.enabled).length} enabled</p>
              <Button variant="outline" size="sm" disabled={unavailable} onClick={() => { setSelectedKind(p.kind); setConnectionId(null); }}>Manage {p.name}<ChevronRight className="ml-1 h-4 w-4" /></Button>
            </div>
          </CardContent>
        </Card>)}
        {providers.length === 0 && <p className="text-sm text-muted-foreground">No built-in integrations returned by the server.</p>}
      </div> : <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" disabled={unavailable} onClick={() => {
              if (connectionId) setConnectionId(null);
              else setSelectedKind(null);
            }}><ArrowLeft className="mr-1 h-4 w-4" />{connectionId ? `Back to ${provider.name}` : 'All built-in providers'}</Button>
            <Badge variant="outline">{provider.kind === 'codex' ? 'Client sign-in' : 'API key'}</Badge>
          </div>
          <CardTitle>{connection ? connection.name : provider.name}</CardTitle>
          <CardDescription>{description(provider.kind)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NamespaceNotice provider={provider} />
          {connection ? <>
            <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div><p className="mb-1 text-xs text-muted-foreground">Connection status</p><ConnectionStatus provider={provider} connection={connection} /></div>
              <div><p className="mb-1 text-xs text-muted-foreground">Model namespace</p><Prefix provider={provider} connection={connection} /></div>
              <div><p className="mb-1 text-xs text-muted-foreground">Imported models</p><p className="font-semibold tabular-nums">{connection.modelCount.toLocaleString()}</p></div>
              <div><p className="mb-1 text-xs text-muted-foreground">Connection ID</p><code className="break-all text-xs">{connection.id}</code></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border p-4"><p className="text-sm text-muted-foreground">Gateway attempts</p><p className="mt-1 text-2xl font-semibold tabular-nums">{connection.usage.requests.toLocaleString()}</p></div>
              <div className="rounded-md border p-4"><p className="text-sm text-muted-foreground">Gateway tokens</p><p className="mt-1 text-2xl font-semibold tabular-nums">{connection.usage.totalTokens.toLocaleString()}</p></div>
            </div>
            <p className="text-xs text-muted-foreground">Usage is recorded by LateDev for this backing connection. Requests count upstream attempts, including retries, not unique client requests. Tokens are recorded input plus output, not the upstream account balance, subscription quota, or billing total.</p>
            <div className="space-y-3 rounded-md border p-4">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1 space-y-1.5">
                  <Label htmlFor="builtin-connection-name">Connection name</Label>
                  <Input id="builtin-connection-name" maxLength={128} disabled={unavailable} value={editingName} onChange={(e) => setEditingName(e.target.value)} />
                </div>
                <Button variant="outline" disabled={unavailable || !editingName.trim() || editingName.trim() === connection.name} onClick={() => void saveName()}>{busy === 'rename' ? 'Saving…' : 'Save name'}</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" disabled={unavailable || provider.kind === 'codex' || !connection.enabled} title={provider.kind === 'codex' ? 'Test from signed-in Codex client' : 'Test connection'} onClick={() => void testConnection()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
                {connection.enabled ? <Button variant="outline" disabled={unavailable} onClick={() => setConfirmDisable(true)}>Disable connection</Button>
                  : <Button disabled={unavailable} onClick={() => void setEnabled(true)}>Enable connection</Button>}
                <Button asChild variant="outline"><Link to="/models">Manage models</Link></Button>
              </div>
              <p className="text-xs text-muted-foreground">Disabling stops routing through this connection without deleting models or routing history.{provider.kind === 'codex' ? ' It does not sign out the Codex client.' : ' Imported models remain pinned to this credential; another connection will not silently replace it.'}</p>
            </div>
            <ConnectionModels key={connection.id} provider={provider} connection={connection} disabled={loading || !!loadError || busy !== null} onBusyChange={setModelBusy} onImported={reload} />
            <div className="space-y-2 rounded-md border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Client configuration</h3><Button variant="outline" size="sm" onClick={() => {
                void navigator.clipboard?.writeText(config).then(() => toast.success('Configuration copied'), () => toast.error('Clipboard unavailable'));
                if (!navigator.clipboard) toast.error('Clipboard unavailable; copy the configuration manually');
              }}><Copy className="mr-1 h-3.5 w-3.5" />Copy configuration</Button></div>
              <p className="text-sm text-muted-foreground">In Models, choose the backing connection named <strong>{connection.name}</strong> ({connection.slug}). Import the desired upstream model first, then replace the placeholder with its exact public model ID.</p>
              {provider.kind === 'codex' ? <p className="text-sm text-muted-foreground">Sign in to the upstream account and test inside Codex. The profile is not a stored upstream account. The API-key configuration below remains supported; use a separate scoped gateway key without token caps. Native Codex combos or their aliases may be used when eligible for the same signed-in account.</p>
                : <p className="text-sm text-muted-foreground">Use a scoped gateway API key in the client environment, not the upstream Anthropic API key. Model IDs select their pinned backing connection. Claude subscription OAuth is not supported.</p>}
              <p className="text-xs text-muted-foreground">Use HTTPS for remote clients.</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">{config}</pre>
              {provider.kind === 'codex' && <div className="space-y-2 border-t pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Alternative: Gateway OAuth</h4><Button variant="outline" size="sm" onClick={() => {
                  void navigator.clipboard?.writeText(gatewayOAuthConfig).then(() => toast.success('Gateway OAuth configuration copied'), () => toast.error('Clipboard unavailable'));
                  if (!navigator.clipboard) toast.error('Clipboard unavailable; copy the configuration manually');
                }}><Copy className="mr-1 h-3.5 w-3.5" />Copy Gateway OAuth config</Button></div>
                <p className="text-sm text-muted-foreground">Use this complete configuration instead of the API-key configuration, with a Codex version that supports gateway OAuth. Keep upstream sign-in enabled. Start gateway sign-in inside Codex, then approve an existing scoped API key in LDrouter. Do not combine both gateway credential methods.</p>
                <p className="text-xs text-muted-foreground">The client receives LDrouter access and refresh tokens using the fixed loopback callback; these do not replace upstream account sign-in or refresh upstream tokens.</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">{gatewayOAuthConfig}</pre>
              </div>}
            </div>
          </> : <>
            {connectionId && <p role="alert" className="text-sm text-destructive">Connection is no longer present in the current catalog.</p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="font-medium">{provider.kind === 'codex' ? 'Client profile' : 'API-key connections'}</h3><p className="text-sm text-muted-foreground">{provider.connections.length} configured</p></div>
              <Button disabled={unavailable || !canCreateBuiltinConnection(provider)} onClick={() => {
                setNewName(''); setNewApiKey(''); setCreateOpen(true);
              }}><Plus className="mr-1 h-4 w-4" />{provider.kind === 'codex' ? 'Add profile' : 'Add connection'}</Button>
            </div>
            {provider.kind === 'codex' && provider.connections.some(c => c.namespaceMode === 'canonical') && <p className="text-xs text-muted-foreground">Only one canonical client profile is supported, including when disabled. Re-enable that profile instead of creating another.</p>}
            {!provider.namespaceAvailable && <p className="text-xs text-muted-foreground">New connections are blocked while the canonical namespace is unavailable.</p>}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Connection</TableHead><TableHead>Model prefix</TableHead><TableHead>Status</TableHead><TableHead>Models</TableHead><TableHead>Attempts</TableHead><TableHead>Tokens</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {provider.connections.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No {provider.kind === 'codex' ? 'profile' : 'connections'} configured.</TableCell></TableRow>}
                  {provider.connections.map((c) => <TableRow key={c.id}>
                    <TableCell><div className="font-medium">{c.name}</div><code className="text-xs text-muted-foreground">{c.slug}</code></TableCell>
                    <TableCell><Prefix provider={provider} connection={c} /></TableCell>
                    <TableCell><ConnectionStatus provider={provider} connection={c} /></TableCell>
                    <TableCell className="tabular-nums">{c.modelCount.toLocaleString()}</TableCell>
                    <TableCell className="tabular-nums">{c.usage.requests.toLocaleString()}</TableCell>
                    <TableCell className="tabular-nums">{c.usage.totalTokens.toLocaleString()}</TableCell>
                    <TableCell className="text-right"><Button variant="outline" size="sm" disabled={unavailable} aria-label={`Manage connection ${c.name}`} onClick={() => openConnection(c)}>Manage connection</Button></TableCell>
                  </TableRow>)}
                </TableBody>
              </Table>
            </div>
          </>}
        </CardContent>
      </Card>}
    <GatewayOAuthGrants />

    <Dialog open={createOpen && !!provider} onOpenChange={(next) => { if (!next && busy === null) clearCreate(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{provider?.kind === 'codex' ? 'Create Codex profile' : 'Add Claude Code connection'}</DialogTitle>
          <DialogDescription>{provider?.kind === 'codex' ? 'Create a local routing profile. No browser login or account token is requested.' : 'Use your authorized Anthropic API key. Subscription credentials are not accepted.'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="builtin-create-name">Name</Label><Input id="builtin-create-name" maxLength={128} value={newName} disabled={busy !== null} onChange={(e) => setNewName(e.target.value)} /></div>
          {provider?.kind === 'claude_code' && <div className="space-y-1.5"><Label htmlFor="builtin-create-key">Anthropic API key</Label><Input id="builtin-create-key" type="password" autoComplete="off" value={newApiKey} disabled={busy !== null} onChange={(e) => setNewApiKey(e.target.value)} /><p className="text-xs text-muted-foreground">Use an API key beginning with sk-ant-api. The key is sent only to the admin API.</p></div>}
          <p className="text-xs text-muted-foreground">New models use the canonical namespace <code>{provider?.slug}/</code>. Existing legacy model IDs remain unchanged.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={clearCreate}>Cancel</Button>
          <Button disabled={unavailable || !provider || !canCreateBuiltinConnection(provider) || !newName.trim() || (provider.kind === 'claude_code' && !/^sk-ant-api[A-Za-z0-9_-]+$/.test(newApiKey.trim()))} onClick={() => void createConnection()}>{busy === 'create' ? 'Creating…' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmDisable && !!connection} onOpenChange={(next) => { if (!next && busy === null) setConfirmDisable(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Disable connection?</AlertDialogTitle><AlertDialogDescription>Routing through {connection?.name} will stop. Imported models, credentials and historical usage are retained. You can enable this connection again.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={unavailable} onClick={(event) => { event.preventDefault(); void setEnabled(false); }}>{busy === 'toggle' ? 'Disabling…' : 'Disable'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}

interface ConnectionModel {
  id: string;
  providerId: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled: boolean;
  upstreamAvailable: boolean;
}

interface DiscoveredConnectionModel {
  upstreamId: string;
  displayName: string;
  alreadyImported: boolean;
  boundElsewhere?: boolean;
  boundConnectionName?: string | null;
}

/**
 * Imports are always bound to the connection UUID represented by this detail
 * view. There is no provider selector, automatic discovery or credential
 * rotation. The import API revalidates catalog membership and ownership.
 */
function ConnectionModels({ provider, connection, disabled, onBusyChange, onImported }: {
  provider: BuiltinProvider;
  connection: BuiltinConnection;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const [models, setModels] = useState<ConnectionModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'discover' | 'import' | null>(null);
  const [manual, setManual] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredConnectionModel[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const prefix = builtinModelPrefix(provider, connection);
  const native = provider.kind === 'codex';
  const manualIds = [...new Set(manual.split(/[\s,]+/).filter(Boolean))];
  const invalidManual = manualIds.some(id => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id));
  const blocked = disabled || loading || !!loadError || busy !== null || !connection.enabled || (connection.namespaceMode === 'canonical' && !provider.namespaceAvailable);
  const query = search.trim().toLowerCase();
  const filtered = (discovered ?? []).filter(d => d.upstreamId.toLowerCase().includes(query) || d.displayName.toLowerCase().includes(query));
  const selectable = (d: DiscoveredConnectionModel) => !d.alreadyImported && !d.boundElsewhere;
  const importIds = native ? manualIds : (discovered ?? []).filter(d => selectable(d) && selected.has(d.upstreamId)).map(d => d.upstreamId);

  const reloadModels = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.get<{ models: ConnectionModel[] }>(`/api/admin/models?providerId=${encodeURIComponent(connection.id)}`);
      setModels(result.models.filter(m => m.providerId === connection.id));
    } catch (error) {
      setLoadError((error as Error).message || 'Unable to load connection models');
    } finally { setLoading(false); }
  }, [connection.id]);
  useEffect(() => { void reloadModels(); }, [reloadModels]);

  async function discover() {
    if (native || blocked) return;
    setBusy('discover');
    onBusyChange(true);
    setDiscovered(null);
    setSelected(new Set());
    setSearch('');
    try {
      const result = await api.post<{ models: DiscoveredConnectionModel[] }>(`/api/admin/providers/${encodeURIComponent(connection.id)}/discover`);
      setDiscovered(result.models);
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(null); onBusyChange(false); }
  }

  async function importModels() {
    if (blocked || importIds.length === 0 || (native && invalidManual)) return;
    setBusy('import');
    onBusyChange(true);
    try {
      const result = await api.post<{ imported: number; requested: number }>('/api/admin/models/import', { providerId: connection.id, modelIds: importIds });
      toast.success(`Imported ${result.imported} of ${result.requested}`);
      setManual('');
      setSelected(new Set());
      setDiscovered(null);
      await Promise.all([reloadModels(), onImported()]);
    } catch (error) {
      toast.error((error as Error).message);
      // Another connection may have claimed an ID since discovery. Require
      // a new catalog fetch rather than resubmitting stale selections.
      setSelected(new Set());
      if (!native) setDiscovered(null);
      await reloadModels();
    } finally { setBusy(null); onBusyChange(false); }
  }

  return <div className="space-y-3 rounded-md border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-semibold">Connection models</h3><p className="text-xs text-muted-foreground">Public IDs use <code>{prefix}/</code> and are pinned to this connection.</p></div>
      <Button variant="outline" size="sm" disabled={loading || disabled || busy !== null} onClick={() => void reloadModels()}>Refresh models</Button>
    </div>
    {loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : loading ? <p role="status" className="text-sm text-muted-foreground">Loading models…</p> :
      <div className="max-h-64 overflow-auto rounded-md border">
        <Table>
          <TableHeader><TableRow><TableHead>Public model ID</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
          <TableBody>
            {models.length === 0 && <TableRow><TableCell colSpan={2} className="text-center text-sm text-muted-foreground">No models imported.</TableCell></TableRow>}
            {models.map(model => <TableRow key={model.id}>
              <TableCell className="break-all font-mono text-xs">{model.publicModelId}</TableCell>
              <TableCell><Badge variant="outline">{!model.enabled || !connection.enabled ? 'Disabled' : !model.upstreamAvailable ? 'Unavailable' : native ? 'Account unverified' : 'Available'}</Badge></TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>}
    {!connection.enabled && <p className="text-xs text-muted-foreground">Enable this connection before importing models.</p>}
    {connection.namespaceMode === 'canonical' && !provider.namespaceAvailable && <p className="text-xs text-muted-foreground">Resolve canonical namespace conflicts before importing models.</p>}
    {native ? <div className="space-y-2">
      <Label htmlFor="builtin-codex-model-ids">Codex upstream model IDs</Label>
      <p className="text-xs text-muted-foreground">Enter exact IDs available to your signed-in client, separated by commas or newlines. Account availability is not verified by this import.</p>
      <textarea id="builtin-codex-model-ids" className="min-h-24 w-full rounded-md border bg-background p-3 font-mono text-sm disabled:opacity-50" value={manual} onChange={e => setManual(e.target.value)} disabled={blocked} placeholder="YOUR_UPSTREAM_MODEL_ID" />
      {invalidManual && <p role="alert" className="text-xs text-destructive">Enter upstream slugs only (not prefixed public model IDs).</p>}
    </div> : <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Fetch the catalog using this connection’s API key. Models already pinned to another connection cannot be selected.</p>
      <Button variant="outline" size="sm" disabled={blocked} onClick={() => void discover()}>{busy === 'discover' ? 'Fetching…' : 'Fetch models'}</Button>
      {discovered !== null && <div className="space-y-2">
        <Input aria-label="Search discovered models" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search models…" disabled={blocked} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{selected.size} selected</p>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={blocked || !filtered.some(selectable)} onClick={() => setSelected(new Set(filtered.filter(selectable).map(d => d.upstreamId)))}>Select all new</Button><Button size="sm" variant="outline" disabled={blocked || selected.size === 0} onClick={() => setSelected(new Set())}>Clear</Button></div>
        </div>
        <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-2">
          {filtered.length === 0 && <p className="p-2 text-sm text-muted-foreground">No matching models.</p>}
          {filtered.map(d => <label key={d.upstreamId} className="flex flex-wrap items-center gap-2 rounded p-1 text-sm hover:bg-accent">
            <Checkbox aria-label={`Import ${d.upstreamId}`} disabled={blocked || !selectable(d)} checked={selected.has(d.upstreamId) && selectable(d)} onCheckedChange={checked => {
              if (!selectable(d)) return;
              setSelected(current => {
                const next = new Set(current);
                if (checked === true) next.add(d.upstreamId); else next.delete(d.upstreamId);
                return next;
              });
            }} />
            <span className="break-all font-mono text-xs">{d.upstreamId}</span>
            {d.boundElsewhere ? <Badge variant="warning">Bound to {d.boundConnectionName || 'another connection'}</Badge> : d.alreadyImported && <Badge variant="secondary">Imported</Badge>}
          </label>)}
        </div>
      </div>}
    </div>}
    <Button disabled={blocked || importIds.length === 0 || (native && invalidManual)} onClick={() => void importModels()}>{busy === 'import' ? 'Importing…' : `Import models${importIds.length ? ` (${importIds.length})` : ''}`}</Button>
  </div>;
}
