// Upstream provider adapters: OpenAI-compatible + Anthropic-compatible.

export interface ProviderConfig {
  type: 'openai' | 'anthropic';
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
  try {
    const url = cfg.type === 'openai' ? `${stripSlash(cfg.baseUrl)}/v1/models` : `${stripSlash(cfg.baseUrl)}/v1/models`;
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
  if (cfg.type === 'openai') return discoverOpenAI(cfg);
  return discoverAnthropic(cfg);
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
    image_input: lower.includes('vision') || lower.includes('gpt-4o') || lower.includes('4-vision') || lower.includes('claude'),
    structured_output: lower.includes('gpt-4') || lower.includes('gpt-3.5') || lower.includes('o1') || lower.includes('claude'),
    reasoning: lower.includes('o1') || lower.includes('o3') || lower.includes('reasoning'),
  };
}

function stripSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

export { buildHeaders, fetchWithTimeout, stripSlash };
