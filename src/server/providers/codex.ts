import { withCodexCredentials, refreshCodexAccount } from './codex-refresh';
import type { CanonicalRequest } from '../routing/capabilities';
import type { DiscoveredModel, ProbeResult } from './index';

export interface CodexProviderConfig {
  baseUrl: string;
  accountId: string;
  accessToken?: string;
  /** Database account id used to acquire and refresh credentials. */
  accountRecordId?: string;
  customHeaders: Record<string, string>;
  totalTimeoutMs: number;
}

export interface CodexCanonicalResult {
  model: string;
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  finishReason: string | null;
  usage: { input: number; output: number; total: number; cacheRead: number; cacheWrite: number; reasoning: number };
}

const base = (url: string) => url.replace(/\/$/, '');
export function codexRequest(cfg: CodexProviderConfig, path: string): string {
  return `${base(cfg.baseUrl)}/backend-api/codex${path.startsWith('/') ? path : `/${path}`}`;
}

export function codexHeaders(cfg: CodexProviderConfig, accept = 'application/json'): Record<string, string> {
  if (!cfg.accessToken) throw new Error('Codex credentials were not acquired');
  return {
    'content-type': 'application/json', accept,
    authorization: `Bearer ${cfg.accessToken}`,
    'chatgpt-account-id': cfg.accountId,
    originator: 'codex_cli_rs',
    'openai-beta': 'responses=experimental',
    ...cfg.customHeaders,
  };
}

function timeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export async function probeCodex(cfg: CodexProviderConfig): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const models = await codexModels(cfg);
    return { ok: true, detail: 'Connected (200)', latencyMs: Date.now() - start, modelCount: models.length };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Codex upstream unavailable', latencyMs: Date.now() - start };
  }
}

export async function codexModels(cfg: CodexProviderConfig): Promise<DiscoveredModel[]> {
  const ctl = timeout(cfg.totalTimeoutMs);
  try {
    const response = await fetch(codexRequest(cfg, '/models'), { headers: codexHeaders(cfg), signal: ctl.signal });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    const body = await response.json() as { models?: Array<{ id?: string; name?: string }> };
    return (body.models ?? []).filter((m): m is { id: string; name?: string } => typeof m.id === 'string').map((m) => ({
      upstreamId: m.id, displayName: m.name ?? m.id,
      capabilities: { responses: true, streaming: true, reasoning: true },
    }));
  } finally { ctl.cancel(); }
}

export function codexRequestPayload(req: CanonicalRequest, targetModel = req.model): Record<string, unknown> {
  const input = req.messages.map((message) => ({ role: message.role, content: message.content.map((block) => {
    if (block.type === 'text') return { type: 'input_text', text: block.text ?? '' };
    if (block.type === 'image' && (block.image?.url || block.image?.base64)) return { type: 'input_image', image_url: block.image?.url ?? `data:${block.image?.mimeType ?? 'image/png'};base64,${block.image?.base64}` };
    return null;
  }).filter(Boolean) }));
  const payload: Record<string, unknown> = { model: targetModel, input, stream: req.stream };
  if (req.system) payload.instructions = req.system;
  if (req.maxOutputTokens !== undefined) payload.max_output_tokens = req.maxOutputTokens;
  if (req.tools?.length) payload.tools = req.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  if (req.reasoning?.effort) payload.reasoning = { effort: req.reasoning.effort };
  return payload;
}

function usage(value: unknown): CodexCanonicalResult['usage'] {
  const u = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  return { input, output, total: input + output, cacheRead: typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 0, cacheWrite: 0, reasoning: typeof u.reasoning_tokens === 'number' ? u.reasoning_tokens : 0 };
}

export function codexResponseToCanonical(body: Record<string, unknown>, requestedModel: string): CodexCanonicalResult {
  let text = '';
  const tools: CodexCanonicalResult['toolCalls'] = [];
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const content = Array.isArray(value.content) ? value.content : [];
    for (const block of content) if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'output_text') text += String((block as Record<string, unknown>).text ?? '');
    if (value.type === 'function_call') tools.push({ id: String(value.call_id ?? value.id ?? ''), name: String(value.name ?? ''), input: value.arguments ?? {} });
  }
  const u = usage(body.usage);
  return { model: requestedModel, text, toolCalls: tools, finishReason: typeof body.status === 'string' ? body.status : null, usage: u };
}

export function codexStreamEventToCanonical(event: Record<string, unknown>): { text: string; isLast: boolean; usage?: CodexCanonicalResult['usage']; finishReason?: string | null } {
  if (event.type === 'response.output_text.delta') return { text: typeof event.delta === 'string' ? event.delta : '', isLast: false };
  if (event.type === 'response.completed') {
    const response = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : {};
    return { text: '', isLast: true, usage: usage(response.usage), finishReason: typeof response.status === 'string' ? response.status : null };
  }
  return { text: '', isLast: false };
}

async function responseError(response: Response): Promise<Error & { status: number }> {
  const error = Object.assign(new Error(`Codex upstream HTTP ${response.status}`), { status: response.status });
  return error;
}

export async function callCodexNonStreaming(cfg: CodexProviderConfig, req: CanonicalRequest): Promise<CodexCanonicalResult & { status: number; upstreamRequestId: string | null }> {
  const call = async (tokenCfg: CodexProviderConfig) => {
    const ctl = timeout(tokenCfg.totalTimeoutMs);
    try {
      const response = await fetch(codexRequest(tokenCfg, '/responses'), { method: 'POST', headers: codexHeaders(tokenCfg), body: JSON.stringify(codexRequestPayload(req)), signal: ctl.signal });
      if (!response.ok) throw await responseError(response);
      return { ...codexResponseToCanonical(await response.json() as Record<string, unknown>, req.model), status: response.status, upstreamRequestId: response.headers.get('x-request-id') };
    } finally { ctl.cancel(); }
  };
  if (cfg.accountRecordId) return withCodexCredentials(cfg.accountRecordId, (credentials) => call({ ...cfg, accessToken: credentials.accessToken }));
  return call(cfg);
}

export async function callCodexStreaming(cfg: CodexProviderConfig, req: CanonicalRequest, onEvent: (event: ReturnType<typeof codexStreamEventToCanonical>) => void): Promise<{ status: number; upstreamRequestId: string | null }> {
  const run = async (tokenCfg: CodexProviderConfig) => {
    const ctl = timeout(tokenCfg.totalTimeoutMs);
    try {
    const response = await fetch(codexRequest(tokenCfg, '/responses'), { method: 'POST', headers: codexHeaders(tokenCfg, 'text/event-stream'), body: JSON.stringify(codexRequestPayload(req)), signal: ctl.signal });
    if (!response.ok || !response.body) throw await responseError(response);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    const process = (raw: string) => { const data = raw.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim(); if (data && data !== '[DONE]') onEvent(codexStreamEventToCanonical(JSON.parse(data) as Record<string, unknown>)); };
    for (;;) { const part = await reader.read(); buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: part.done }); let index; while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) { process(buffer.slice(0, index)); buffer = buffer.slice(index + (buffer[index] === '\r' ? 4 : 2)); } if (part.done) break; }
    if (buffer.trim()) process(buffer.replace(/\r?\n$/, ''));
    return { status: response.status, upstreamRequestId: response.headers.get('x-request-id') };
    } finally { ctl.cancel(); }
  };
  if (cfg.accountRecordId) return withCodexCredentials(cfg.accountRecordId, (credentials) => run({ ...cfg, accessToken: credentials.accessToken }));
  return run(cfg);
}

/* eslint-disable preserve-caught-error -- safe refresh failure intentionally omits credentials */
export async function withCodexUpstream<T>(accountId: string, refresh: () => Promise<{ ok: boolean }>, call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) {
    if (!error || typeof error !== 'object' || !([401, 403] as unknown[]).includes((error as { status?: number }).status)) throw error;
    const result = await refresh();
    if (!result.ok) throw new Error('Codex credential refresh failed', { cause: new Error('refresh_failed') });
    return call();
  }
}
/* eslint-enable preserve-caught-error */

export { refreshCodexAccount, withCodexCredentials };
