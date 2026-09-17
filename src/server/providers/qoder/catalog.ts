// Qoder credential exchange and live model catalog.
// A PAT (pt-) cannot sign COSY requests, so it is exchanged for a short-lived job
// token (jt-) over plain JSON, then userinfo supplies the stable user id that signing
// requires. The inference host is api2 for job tokens; api3 rejects them.
import { buildCosyHeaders } from './cosy';
import { QODER_JOB_TOKEN_EXCHANGE_URL, QODER_MODEL_LIST_URL, QODER_USERINFO_URL } from './constants';

const FETCH_TIMEOUT_MS = 15_000;
const PAT_PREFIX = 'pt-';

export interface QoderCatalogEntry {
  key: string;
  displayName: string;
  enabled: boolean;
  isReasoning: boolean;
  isVl: boolean;
  /** Upstream marks promotion-covered models `is_free`: they do not draw on Credits. */
  isFree: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  raw: Record<string, unknown>;
}

export interface QoderCatalog {
  entries: Map<string, QoderCatalogEntry>;
  fetchedAt: string;
}

export interface QoderPatExchange {
  jobToken: string;
  jobTokenExpiresAt: string;
  qoderUserId: string;
  email: string | null;
  label: string | null;
}

export function isQoderPat(token: unknown): boolean {
  return typeof token === 'string' && token.startsWith(PAT_PREFIX);
}

export interface CatalogDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function timedFetch(url: string, init: RequestInit, deps: CatalogDeps = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function parseCatalog(body: unknown, fetchedAt: string): QoderCatalog {
  const entries = new Map<string, QoderCatalogEntry>();
  const chat = body && typeof body === 'object' ? (body as { chat?: unknown }).chat : null;
  if (!Array.isArray(chat)) return { entries, fetchedAt };
  for (const item of chat) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (!key) continue;
    entries.set(key, {
      key,
      displayName: typeof raw.display_name === 'string' && raw.display_name ? raw.display_name : key,
      // A disabled entry stays routable: the admin may still select it, and chat sends
      // the live model_config regardless.
      enabled: raw.enable !== false,
      isReasoning: raw.is_reasoning === true,
      isVl: raw.is_vl === true,
      isFree: raw.is_free === true,
      maxInputTokens: numberOr(raw.max_input_tokens, 0),
      maxOutputTokens: numberOr(raw.max_output_tokens, 0),
      raw,
    });
  }
  return { entries, fetchedAt };
}

// The serialized form deliberately keeps each entry's `raw` config: chat must send the
// live model_config and never re-derive it from the parsed fields.
export function serializeCatalog(catalog: QoderCatalog): string {
  return JSON.stringify({
    fetchedAt: catalog.fetchedAt,
    entries: [...catalog.entries.values()].map((entry) => ({ ...entry })),
  });
}

export function deserializeCatalog(raw: string | null): QoderCatalog | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; entries?: unknown };
    const entries = new Map<string, QoderCatalogEntry>();
    if (Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries as QoderCatalogEntry[]) {
        if (!entry?.key) continue;
        // Catalogs cached before `isFree` existed carry only `raw.is_free`, so re-derive it
        // rather than showing an empty free-model list until the next catalog refresh.
        entries.set(entry.key, entry.isFree === undefined ? { ...entry, isFree: entry.raw?.is_free === true } : entry);
      }
    }
    return { entries, fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '' };
  } catch {
    return null;
  }
}

export async function exchangeQoderPat(personalToken: string, deps: CatalogDeps = {}): Promise<QoderPatExchange> {
  if (!isQoderPat(personalToken)) throw new Error('not a Qoder personal access token (expected a pt- value)');
  const response = await timedFetch(
    QODER_JOB_TOKEN_EXCHANGE_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'qodercli/1.0.0' },
      body: JSON.stringify({ personal_token: personalToken }),
    },
    deps,
  );
  if (!response.ok) throw new Error(`Qoder personal access token exchange failed: HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const jobToken = typeof body.token === 'string' ? body.token : '';
  if (!jobToken) throw new Error('Qoder personal access token exchange returned no job token');
  const explicit = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
  const relative = typeof body.expires_in === 'number' && body.expires_in > 0 ? Date.now() + body.expires_in * 1000 : NaN;
  // The upstream usually omits both; a job token is short-lived, so default to 24h and
  // let a 401 at request time trigger an early re-exchange.
  const expiresAt = new Date(
    Number.isFinite(explicit) ? explicit : Number.isFinite(relative) ? relative : Date.now() + 24 * 60 * 60 * 1000,
  ).toISOString();
  const info = await fetchQoderUserInfo(jobToken, deps);
  return { jobToken, jobTokenExpiresAt: expiresAt, qoderUserId: info.qoderUserId, email: info.email, label: info.label };
}

export async function fetchQoderUserInfo(
  jobToken: string,
  deps: CatalogDeps = {},
): Promise<{ qoderUserId: string; email: string | null; label: string | null }> {
  try {
    const response = await timedFetch(
      QODER_USERINFO_URL,
      { method: 'GET', headers: { authorization: `Bearer ${jobToken}`, accept: 'application/json', 'user-agent': 'qodercli/1.0.0' } },
      deps,
    );
    if (!response.ok) return { qoderUserId: '', email: null, label: null };
    const body = (await response.json()) as Record<string, unknown>;
    const pick = (...values: unknown[]): string | null => {
      for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
      return null;
    };
    return {
      qoderUserId: pick(body.id, body.userId, body.user_id) ?? '',
      email: pick(body.email),
      label: pick(body.name, body.username),
    };
  } catch {
    return { qoderUserId: '', email: null, label: null };
  }
}

/** null on any failure: the caller decides whether that is fatal (it is, for cached model_config). */
export async function fetchQoderCatalog(
  creds: { jobToken: string; userId: string; machineId: string },
  deps: CatalogDeps = {},
): Promise<QoderCatalog | null> {
  const headers = {
    accept: 'application/json',
    'accept-encoding': 'identity',
    ...buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, { userId: creds.userId, authToken: creds.jobToken, machineId: creds.machineId }),
  };
  try {
    const response = await timedFetch(QODER_MODEL_LIST_URL, { method: 'GET', headers }, deps);
    if (!response.ok) return null;
    return parseCatalog(await response.json(), new Date().toISOString());
  } catch {
    return null;
  }
}
