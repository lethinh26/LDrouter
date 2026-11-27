// Upstream provider adapters: OpenAI-compatible + Anthropic-compatible.

export interface ProviderConfig {
  type: 'openai' | 'anthropic';
  providerKind?: 'compatible' | 'codex' | 'claude_code';
  baseUrl: string;
  apiKey: string;
  customHeaders: Record<string, string>;
  connectTimeoutMs: number;
  firstTokenTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  totalTimeoutMs: number;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  latencyMs: number;
  modelCount?: number;
}

export interface DiscoveredModel {
  upstreamId: string;
  displayName: string;
  capabilities: {
    chat?: boolean;
    responses?: boolean;
    streaming?: boolean;
    tools?: boolean;
    structured_output?: boolean;
    image_input?: boolean;
    audio_input?: boolean;
    reasoning?: boolean;
    embeddings?: boolean;
    max_context_tokens?: number | null;
    max_output_tokens?: number | null;
  };
  rawMetadata?: Record<string, unknown>;
}

function buildHeaders(cfg: ProviderConfig, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'latedev-router/0.1',
    ...cfg.customHeaders,
    ...(extra ?? {}),
  };
  if (cfg.type === 'openai') h['authorization'] = `Bearer ${cfg.apiKey}`;
  else h['x-api-key'] = cfg.apiKey;
  return h;
}

async function fetchWithTimeout(url: string, init: RequestInit, totalTimeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), totalTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeProvider(cfg: ProviderConfig): Promise<ProbeResult> {
  const start = Date.now();
  if (cfg.type !== 'openai' && cfg.type !== 'anthropic') return { ok: false, detail: 'Unsupported provider type', latencyMs: 0 };
  try {
    if (cfg.providerKind === 'claude_code') {
      const models = await discoverClaudeCode(cfg);
      return { ok: true, detail: 'Connected', latencyMs: Date.now() - start, modelCount: models.length };
    }
    const url = `${stripSlash(cfg.baseUrl)}/v1/models`;
    const res = await fetchWithTimeout(url, { method: 'GET', headers: buildHeaders(cfg) }, cfg.totalTimeoutMs);
    const latency = Date.now() - start;
    if (res.ok) {
      const body = (await res.json()) as { data?: unknown[] } | unknown[];
      const count = Array.isArray(body) ? body.length : Array.isArray((body as { data?: unknown[] }).data) ? (body as { data: unknown[] }).data.length : 0;
      return { ok: true, detail: `Connected (${res.status})`, latencyMs: latency, modelCount: count };
    }
    return { ok: false, detail: `HTTP ${res.status}`, latencyMs: latency };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, latencyMs: Date.now() - start };
  }
}

export async function discoverProviderModels(cfg: ProviderConfig): Promise<DiscoveredModel[]> {
  if (cfg.providerKind === 'claude_code') return discoverClaudeCode(cfg);
  if (cfg.type === 'openai') return discoverOpenAI(cfg);
  if (cfg.type === 'anthropic') return discoverAnthropic(cfg);
  throw new Error('Unsupported provider type');
}

async function discoverClaudeCode(cfg: ProviderConfig): Promise<DiscoveredModel[]> {
  if (cfg.type !== 'anthropic' || cfg.baseUrl !== 'https://api.anthropic.com' || !/^sk-ant-api[A-Za-z0-9_-]+$/.test(cfg.apiKey)) throw new Error('Invalid Claude Code API credential or destination');
  const models = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(cfg.totalTimeoutMs);
  const url = new URL('https://api.anthropic.com/v1/models');
  url.searchParams.set('limit', '100');
  for (let page = 0; page < 20; page++) {
    const res = await fetch(url, { headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' }, redirect: 'error', signal });
    if (!res.ok) { void res.body?.cancel().catch(() => undefined); throw new Error(`Claude model catalog HTTP ${res.status}`); }
    const body = await res.json() as { data?: { id: string; display_name?: string }[]; has_more?: boolean; last_id?: string };
    if (!Array.isArray(body.data)) throw new Error('Invalid Claude model catalog');
    for (const model of body.data) if (typeof model?.id === 'string' && model.id) models.set(model.id, { upstreamId: model.id, displayName: model.display_name || model.id, capabilities: { chat: true, streaming: true, tools: true } });
    if (!body.has_more) return [...models.values()];
    if (typeof body.last_id !== 'string' || !body.last_id || cursors.has(body.last_id)) throw new Error('Invalid Claude model catalog cursor');
    cursors.add(body.last_id); url.searchParams.set('after_id', body.last_id);
  }
  throw new Error('Claude model catalog pagination limit exceeded');
}

async function discoverOpenAI(cfg: ProviderConfig): Promise<DiscoveredModel[]> {
  const all: DiscoveredModel[] = [];
  let url: string | null = `${stripSlash(cfg.baseUrl)}/v1/models`;
  while (url) {
    const res = await fetchWithTimeout(url, { method: 'GET', headers: buildHeaders(cfg) }, cfg.totalTimeoutMs);
    if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    for (const m of body.data ?? []) {
      all.push({
        upstreamId: m.id,
        displayName: m.id,
        capabilities: inferOpenAICapabilities(m.id),
      });
    }
    break; // OpenAI list models is not paginated by default; if upstream returns next, we could follow.
  }
  return all;
}

async function discoverAnthropic(_cfg: ProviderConfig): Promise<DiscoveredModel[]> {
  // Anthropic has no public model listing API; provide best-effort common defaults.
  // In production deployments, admins add models manually or via custom discovery.
  return [
    { upstreamId: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet', capabilities: { chat: true, streaming: true, tools: true, image_input: true } },
    { upstreamId: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku', capabilities: { chat: true, streaming: true, tools: true } },
    { upstreamId: 'claude-3-opus-latest', displayName: 'Claude 3 Opus', capabilities: { chat: true, streaming: true, tools: true, image_input: true } },
  ];
}

function inferOpenAICapabilities(id: string): DiscoveredModel['capabilities'] {
  const lower = id.toLowerCase();
  return {
    chat: true,
    streaming: true,
    tools: !(lower.includes('embedding') || lower.includes('whisper') || lower.includes('dall-e') || lower.includes('tts')),
    // image_input / structured_output / reasoning are intentionally omitted.
    // A guessed `false` is read as "known unsupported" and hard-rejects matching
    // requests (docs/04 §capability filtering); docs/00 requires unknown
    // capabilities to stay unknown, so leave them undefined (undefined = allow).
    // ponytail: name-based guessing was wrong for most ids (e.g. qwen-vl-max,
    // claude-sonnet-4-5). Upgrade path: a real /models metadata probe, or the
    // admin capability override UI.
  };
}

function stripSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

/**
 * Merge freshly discovered capabilities into a stored model record.
 *
 * `baseline` is what discovery last wrote for this model. An admin edit is by
 * definition a divergence from that baseline, so those keys survive a
 * re-import; everything else is refreshed (this is what clears stale guesses
 * such as `image_input: false`). A record with no baseline predates this
 * tracking, so it is refreshed wholesale rather than preserved blindly.
 */
export function mergeDiscoveredCapabilities(
  stored: Record<string, unknown>,
  baseline: Record<string, unknown> | null,
  discovered: Record<string, unknown>
): { capabilities: Record<string, unknown>; baseline: Record<string, unknown> } {
  const overrides: Record<string, unknown> = {};
  if (baseline) {
    for (const [k, v] of Object.entries(stored)) if (stored[k] !== baseline[k]) overrides[k] = v;
  }
  return { capabilities: { ...discovered, ...overrides }, baseline: discovered };
}

export { buildHeaders, fetchWithTimeout, stripSlash };
