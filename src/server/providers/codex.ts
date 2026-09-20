import { withCodexCredentials, refreshCodexAccount } from './codex-refresh';
import { redactString, redactValue } from '../security/redact';
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
/**
 * Reported Codex CLI client version. The models endpoint rejects requests without it:
 * `400 [{'loc': ('query', 'client_version'), 'msg': 'Field required'}]`.
 */
export const CODEX_CLIENT_VERSION = '0.144.6';

/**
 * The Codex OAuth backend only exists on chatgpt.com — `api.openai.com/backend-api/codex/*`
 * answers 404. The base URL is therefore not user-configurable: a stored value pointing
 * anywhere else makes discovery and routing fail with an opaque 404.
 */
export const CODEX_BASE_URL = 'https://chatgpt.com';

/** Shape the Codex models endpoint returns; only the identifier and label are used. */
interface CodexModelEntry {
  slug?: string; id?: string; model?: string; name?: string;
  display_name?: string; displayName?: string;
}

export function codexRequest(cfg: CodexProviderConfig, path: string): string {
  // Always chatgpt.com: the Codex OAuth backend does not exist on api.openai.com,
  // so a stored base URL pointing elsewhere yields an opaque 404. See CODEX_BASE_URL.
  return `${base(CODEX_BASE_URL)}/backend-api/codex${path.startsWith('/') ? path : `/${path}`}`;
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
    const response = await fetch(`${codexRequest(cfg, '/models')}?client_version=${CODEX_CLIENT_VERSION}`, { headers: codexHeaders(cfg), signal: ctl.signal });
    // status is required: withCodexCredentials keys its one-shot refresh-and-retry off it.
    if (!response.ok) throw Object.assign(new Error(`Provider returned HTTP ${response.status}`), { status: response.status });
    const body = await response.json() as { models?: CodexModelEntry[] } | CodexModelEntry[];
    const entries = Array.isArray(body) ? body : body.models ?? [];
    // Upstream identifies models by `slug`; other deployments may use id/model/name.
    return entries.flatMap((entry) => {
      const id = [entry.slug, entry.id, entry.model, entry.name].find((value): value is string => typeof value === 'string' && value.length > 0);
      if (!id) return [];
      return [{
        upstreamId: id,
        displayName: entry.display_name ?? entry.displayName ?? entry.name ?? id,
        capabilities: { responses: true, streaming: true, reasoning: true },
      }];
    });
  } finally { ctl.cancel(); }
}

/**
 * The Codex backend rejects any request that does not set both flags verbatim:
 * `{"detail":"Store must be set to false"}` / `{"detail":"Stream must be set to true"}`.
 * Upstream always streams; non-streaming callers merge the stream below.
 */
const CODEX_REQUIRED_FLAGS = { store: false, stream: true } as const;

export function codexRequestPayload(req: CanonicalRequest, targetModel = req.model): Record<string, unknown> {
  const input = codexInputItems(req.messages);
  const payload: Record<string, unknown> = { model: targetModel, input, ...CODEX_REQUIRED_FLAGS };
  if (req.system) payload.instructions = req.system;
  // max_output_tokens, temperature and top_p are NOT forwarded: the Codex backend rejects each
  // with 400 "Unsupported parameter" (verified live against chatgpt.com). The Codex CLI omits them
  // too, so a client that sets max_tokens on a codex/ model still gets a working request.
  if (req.tools?.length) payload.tools = req.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  if (req.reasoning?.effort) payload.reasoning = { effort: req.reasoning.effort };
  return payload;
}

type CodexInputItem = Record<string, unknown>;

/**
 * Translate canonical messages into the Responses `input` array.
 *
 * The backend is strict about which item shapes are legal and rejects the rest
 * with `400 invalid_value`, naming the offending `input[i]` path:
 *  - a text block on an assistant turn must be `output_text`; `input_text` is
 *    rejected ("Invalid value: 'input_text'. Supported values are: 'output_text'
 *    and 'refusal'"). So a plain chat follow-up — history contains an assistant
 *    turn — failed while the first message of a conversation worked.
 *  - tool calls and their results are NOT content blocks: a `function_call`
 *    inside `content` is rejected ("Supported values are: 'input_text',
 *    'input_image', …"). They are top-level items, `function_call` and
 *    `function_call_output`, correlated by `call_id`.
 * Verified live against chatgpt.com.
 */
export function codexInputItems(messages: CanonicalRequest['messages']): CodexInputItem[] {
  const items: CodexInputItem[] = [];
  for (const message of messages) {
    const content: CodexInputItem[] = [];
    const flushMessage = () => {
      if (content.length > 0) items.push({ role: message.role, content: [...content] });
      content.length = 0;
    };
    for (const block of message.content) {
      if (block.type === 'text') {
        // Assistant prose is "output" from the API's point of view; everything else is input.
        content.push(message.role === 'assistant' ? { type: 'output_text', text: block.text ?? '' } : { type: 'input_text', text: block.text ?? '' });
        continue;
      }
      if (block.type === 'image' && (block.image?.url || block.image?.base64)) {
        content.push({ type: 'input_image', image_url: block.image?.url ?? `data:${block.image?.mimeType ?? 'image/png'};base64,${block.image?.base64}` });
        continue;
      }
      if (block.type === 'tool_use' && block.toolUse) {
        // Top-level item, so the message wrapping the call is emitted first.
        flushMessage();
        items.push({
          type: 'function_call',
          call_id: block.toolUse.id,
          name: block.toolUse.name,
          arguments: typeof block.toolUse.input === 'string' ? block.toolUse.input : JSON.stringify(block.toolUse.input ?? {}),
        });
        continue;
      }
      if (block.type === 'tool_result' && block.toolResult) {
        flushMessage();
        items.push({
          type: 'function_call_output',
          call_id: block.toolResult.toolUseId,
          output: typeof block.toolResult.content === 'string' ? block.toolResult.content : JSON.stringify(block.toolResult.content ?? ''),
        });
      }
    }
    flushMessage();
  }
  return items;
}

function usage(value: unknown): CodexCanonicalResult['usage'] {
  const u = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  // The Responses API nests both of these (`usage.input_tokens_details.cached_tokens`,
  // `usage.output_tokens_details.reasoning_tokens`). Reading only the flat names returned
  // 0 for every Codex request — 1,381 of them, 46% of all traffic — so the statistics page
  // reported a cache-hit rate missing its largest contributor. Flat names stay supported
  // for compatibility with OpenAI-compatible upstreams that use them.
  const inDetails = (u.input_tokens_details && typeof u.input_tokens_details === 'object' ? u.input_tokens_details : {}) as Record<string, unknown>;
  const outDetails = (u.output_tokens_details && typeof u.output_tokens_details === 'object' ? u.output_tokens_details : {}) as Record<string, unknown>;
  const cacheRead = typeof inDetails.cached_tokens === 'number' ? inDetails.cached_tokens
    : typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 0;
  const reasoning = typeof outDetails.reasoning_tokens === 'number' ? outDetails.reasoning_tokens
    : typeof u.reasoning_tokens === 'number' ? u.reasoning_tokens : 0;
  return { input, output, total: input + output, cacheRead, cacheWrite: 0, reasoning };
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

export function codexStreamEventToCanonical(event: Record<string, unknown>): { text: string; isLast: boolean; usage?: CodexCanonicalResult['usage']; finishReason?: string | null; toolCall?: CodexCanonicalResult['toolCalls'][number] } {
  if (event.type === 'response.output_text.delta') return { text: typeof event.delta === 'string' ? event.delta : '', isLast: false };
  if (event.type === 'response.output_item.done') {
    // `response.completed` always carries `output: []`, so function calls are only
    // observable here — this is what lets a non-streaming merge see tool calls.
    const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : {};
    if (item.type !== 'function_call') return { text: '', isLast: false };
    const raw = item.arguments;
    let input: unknown = raw ?? {};
    if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = raw; } }
    return { text: '', isLast: false, toolCall: { id: String(item.call_id ?? item.id ?? ''), name: String(item.name ?? ''), input } };
  }
  if (event.type === 'response.completed') {
    const response = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : {};
    return { text: '', isLast: true, usage: usage(response.usage), finishReason: typeof response.status === 'string' ? response.status : null };
  }
  return { text: '', isLast: false };
}

async function responseError(response: Response): Promise<Error & { status: number }> {
  // The backend explains every rejection (`{"error":{"message":"Invalid value: ...","param":"input[1].content[0]"}}`).
  // Without it an operator only sees "HTTP 400" and has to re-derive the cause by hand.
  let detail = '';
  try {
    const parsed = JSON.parse(await response.text()) as Record<string, unknown> & { error?: { message?: unknown; param?: unknown }; detail?: unknown };
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : typeof parsed.detail === 'string' ? parsed.detail : null;
    // redactValue, not just redactString: an error body can echo a secret under a
    // secret-named key, which only the structured pass recognizes.
    detail = message
      ? `: ${message}${typeof parsed.error?.param === 'string' ? ` (param ${parsed.error.param})` : ''}`
      : `: ${JSON.stringify(redactValue(parsed))}`;
  } catch { /* a non-JSON or already-read body must not mask the status */ }
  const error = Object.assign(new Error(`Codex upstream HTTP ${response.status}${redactString(detail).slice(0, 500)}`), { status: response.status });
  return error;
}

export async function callCodexNonStreaming(cfg: CodexProviderConfig, req: CanonicalRequest): Promise<CodexCanonicalResult & { status: number; upstreamRequestId: string | null }> {
  // The Codex backend rejects `stream:false`, so a non-streaming caller merges the
  // stream itself instead of asking upstream for a single JSON body.
  let text = '';
  const toolCalls: CodexCanonicalResult['toolCalls'] = [];
  let finishReason: string | null = null;
  let usage: CodexCanonicalResult['usage'] = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const meta = await callCodexStreaming(cfg, req, (event) => {
    text += event.text;
    if (event.toolCall) toolCalls.push(event.toolCall);
    if (event.usage) usage = event.usage;
    if (event.isLast && event.finishReason !== undefined) finishReason = event.finishReason;
  });
  return { model: req.model, text, toolCalls, finishReason, usage, status: meta.status, upstreamRequestId: meta.upstreamRequestId };
}

export async function callCodexStreaming(cfg: CodexProviderConfig, req: CanonicalRequest, onEvent: (event: ReturnType<typeof codexStreamEventToCanonical>) => void): Promise<{ status: number; upstreamRequestId: string | null }> {
  const run = async (tokenCfg: CodexProviderConfig) => {
    const ctl = timeout(tokenCfg.totalTimeoutMs);
    try {
    const response = await fetch(codexRequest(tokenCfg, '/responses'), { method: 'POST', headers: codexHeaders(tokenCfg, 'text/event-stream'), body: JSON.stringify(codexRequestPayload(req)), signal: ctl.signal });
    // Only a failed response is read as text here; a 2xx with no body must still report its status.
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw Object.assign(new Error(`Codex upstream HTTP ${response.status}: empty response body`), { status: response.status });
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
