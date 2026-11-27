import { GatewayError } from '../errors';
import { CODEX_API_PATH, CODEX_ORIGIN } from '../providers/integration';

export type CodexCatalogEntry = Record<string, unknown> & { slug: string };
type ClientAuth = { authorization: string; accountId?: string };

/** Account-local, request-local discovery. Never persist or share its result. */
export async function fetchCodexCatalog(auth: ClientAuth, clientVersion?: string, requestSignal?: AbortSignal): Promise<CodexCatalogEntry[]> {
  const url = new URL(`${CODEX_ORIGIN}${CODEX_API_PATH}/models`);
  if (clientVersion && /^\d+\.\d+\.\d+$/.test(clientVersion)) url.searchParams.set('client_version', clientVersion);
  const timeout = AbortSignal.timeout(20000);
  const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: auth.authorization, ...(auth.accountId ? { 'ChatGPT-Account-ID': auth.accountId } : {}), accept: 'application/json' }, redirect: 'error', signal });
  } catch {
    if (requestSignal?.aborted) throw requestSignal.reason;
    throw new GatewayError('upstream_unavailable', 'Codex catalog connection failed', { status: 502 });
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new GatewayError(response.status === 401 || response.status === 403 ? 'upstream_auth_error' : response.status === 429 ? 'upstream_rate_limit' : 'upstream_error', `Codex catalog HTTP ${response.status}`, { status: [401,403,429].includes(response.status) ? response.status : 502 });
  }
  const invalid = () => new GatewayError('upstream_error', 'Invalid Codex catalog', { status: 502 });
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw invalid();
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { models?: unknown[] };
    if (!parsed || !Array.isArray(parsed.models)) throw invalid();
    const entries = parsed.models.filter((entry): entry is CodexCatalogEntry => entry !== null && typeof entry === 'object' && 'slug' in entry && typeof entry.slug === 'string');
    if (new Set(entries.map(e => e.slug)).size !== entries.length) throw invalid();
    return entries;
  } catch {
    void reader.cancel().catch(() => undefined);
    if (requestSignal?.aborted) throw requestSignal.reason;
    throw invalid();
  } finally { reader.releaseLock(); }
}

// Only cosmetic/identity fields are ignored. Unknown behavioral metadata must
// match too, rather than manufacturing a model capability intersection.
const cosmetic = new Set(['slug', 'display_name', 'description', 'priority', 'upgrade']);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

export function compatibleCodexEntries(catalog: CodexCatalogEntry[], slugs: string[]): CodexCatalogEntry[] | null {
  if (!slugs.length || new Set(slugs).size !== slugs.length) return null;
  const found = slugs.map(slug => catalog.find(entry => entry.slug === slug));
  if (found.some(e => !e)) return null;
  const entries = found as CodexCatalogEntry[];
  if (entries.some(e => typeof e.context_window !== 'number' || !Number.isSafeInteger(e.context_window) || e.context_window <= 0 || !Array.isArray(e.supported_reasoning_levels))) return null;
  const signature = (entry: CodexCatalogEntry) => JSON.stringify(canonical(Object.fromEntries(Object.entries(entry).filter(([k]) => !cosmetic.has(k)))));
  const first = signature(entries[0]!);
  return entries.every(e => signature(e) === first) ? entries : null;
}

/** Model-bound server state is not a transferable conversation contract. */
export function validateCodexComboHistory(body: Record<string, unknown>): void {
  const pending: unknown[] = [body.input];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { for (const item of value) pending.push(item); continue; }
    const item = value as Record<string, unknown>;
    if (item.encrypted_content != null || item.type === 'item_reference') throw new GatewayError('invalid_request_error', 'Use a direct Codex model for model-bound conversation history', { status: 400, code: 'codex_combo_model_bound_history' });
    for (const child of Object.values(item)) pending.push(child);
  }
}
