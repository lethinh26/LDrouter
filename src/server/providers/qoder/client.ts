// Qoder chat adapter: canonical request -> Qoder payload -> obfuscated body -> COSY-signed
// fetch -> OpenAI-shaped chunks -> canonical aggregate.
//
// Two behaviours the runner depends on:
//   - Streaming emits OpenAI chunks and STOPS at the terminal frame. Qoder keeps the
//     socket open after [DONE]; a client that drains would hang.
//   - A missing live model_config is a hard error. Sending the wrong block makes the
//     upstream silently serve a different model.
import { createHash, randomUUID } from 'node:crypto';
import { GatewayError } from '../../errors';
import { redactString } from '../../security/redact';
import type { CanonicalRequest } from '../../routing/capabilities';
import type { DiscoveredModel, ProbeResult } from '../index';
import type { QoderCatalog } from './catalog';
import { QODER_CHAT_URL, QODER_CHAT_SIG_PATH } from './constants';
import { buildCosyHeaders } from './cosy';
import { encodeQoderBody } from './encode';
import { QoderEnvelopeReader, type QoderUsage } from './sse';
import { applyQoderContextTier, resolveQoderContextTier } from './tier';

export class QoderModelConfigMissingError extends Error {
  readonly status = 400;
  constructor(key: string) {
    super(`Qoder model_config for "${key}" is not cached — discover or refresh this account's models first`);
    this.name = 'QoderModelConfigMissingError';
  }
}

export interface QoderProviderConfig {
  accountRecordId: string;
  qoderUserId: string;
  jobToken: string;
  machineId: string;
  name?: string;
  email?: string;
  totalTimeoutMs: number;
  catalog: QoderCatalog | null;
}

export interface QoderCanonicalResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  finishReason: string | null;
  usage: QoderUsage;
}

export interface QoderDeps { fetchImpl?: typeof fetch }

const emptyUsage = (): QoderUsage => ({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

function blocksToParts(content: CanonicalRequest['messages'][number]['content']): { text: string; parts: Array<Record<string, unknown>> } {
  const parts: Array<Record<string, unknown>> = [];
  let text = '';
  for (const block of content) {
    if (block.type === 'text' && block.text) { parts.push({ type: 'text', text: block.text }); text += block.text; continue; }
    const image = block.type === 'image' ? block.image : undefined;
    const url = image?.url ?? (image?.base64 ? `data:${image.mimeType ?? 'image/png'};base64,${image.base64}` : undefined);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return { text, parts };
}

function normalizeMessage(message: CanonicalRequest['messages'][number]): Record<string, unknown> {
  const { text, parts } = blocksToParts(message.content);
  const hasImage = parts.some((part) => part.type === 'image_url');
  // Qoder reads documents through its own file API; a 30MB inline document is not a request.
  const toolCalls = message.content.filter((block) => block.type === 'tool_use').map((block) => ({ id: block.toolUse?.id ?? '', type: 'function', function: { name: block.toolUse?.name ?? '', arguments: JSON.stringify(block.toolUse?.input ?? {}) } }));
  return {
    role: message.role,
    content: hasImage ? parts : text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function stableHash(prefix: string, ...parts: Array<string | number | undefined>): string {
  const hash = createHash('sha256').update(prefix);
  for (const part of parts) hash.update('\0').update(String(part ?? ''));
  return hash.digest('hex').slice(0, 24);
}

/**
 * Build the exact payload Qoder expects. Throws QoderModelConfigMissingError when the
 * account has no cached model_config for this key — never guesses.
 */
export function qoderRequestPayload(
  req: CanonicalRequest,
  modelKey: string,
  catalog: QoderCatalog | null,
  options: { contextPreference?: string } = {},
): { payload: Record<string, unknown>; modelConfig: Record<string, unknown> } {
  const entry = catalog?.entries.get(modelKey);
  if (!entry) throw new QoderModelConfigMissingError(modelKey);

  const modelConfig = { ...entry.raw, key: modelKey };
  const isReasoning = entry.isReasoning;
  const messages = req.messages.map(normalizeMessage);
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content) ? (lastUser.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n') : '';

  const declaredMax = entry.maxOutputTokens > 0 ? entry.maxOutputTokens : 32_768;
  const requestedMax = req.maxOutputTokens ?? 0;
  const maxTokens = requestedMax > 0 ? Math.min(requestedMax, declaredMax) : declaredMax;

  const tools = (req.tools ?? []).map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  const recordId = stableHash('qoder-record', modelKey, JSON.stringify(messages), JSON.stringify(tools), maxTokens);

  const payload: Record<string, unknown> = {
    request_id: randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: stableHash('qoder-session', modelKey),
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: req.system ?? '',
    messages,
    tools,
    parameters: { max_tokens: maxTokens },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: { context: [], modelConfig: { key: modelKey, is_reasoning: isReasoning }, originalContent: lastUserText },
      features: [],
      text: lastUserText,
    },
    model_config: modelConfig,
    business: {
      product: 'cli', version: '1.0.0', type: 'agent', stage: 'start',
      id: randomUUID(), name: lastUserText.slice(0, 30), begin_at: Date.now(),
    },
  };

  const tier = resolveQoderContextTier(modelConfig, { system: req.system, messages, tools }, { preference: options.contextPreference });
  if (tier) applyQoderContextTier(payload, tier.tier);
  return { payload, modelConfig };
}

/** Thrown before any byte is written downstream, so the runner can still fail over. */
export class QoderUpstreamError extends Error {
  constructor(readonly status: number, message: string, readonly billing = false) {
    super(message);
    this.name = 'QoderUpstreamError';
  }
}

function signedInit(cfg: QoderProviderConfig, payload: Record<string, unknown>, modelKey: string): { init: RequestInit } {
  // encodeQoderBody returns latin1-mapped text; the COSY signature hashes exactly these
  // bytes, so the body must be reconstructed with the same encoding.
  const encoded = Buffer.from(encodeQoderBody(Buffer.from(JSON.stringify(payload), 'utf8')), 'latin1');
  return {
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'cache-control': 'no-cache',
        'accept-encoding': 'identity',
        'x-model-key': modelKey,
        'x-model-source': String((payload.model_config as Record<string, unknown> | undefined)?.source ?? 'system'),
        ...buildCosyHeaders(encoded, QODER_CHAT_URL, { userId: cfg.qoderUserId, authToken: cfg.jobToken, name: cfg.name, email: cfg.email, machineId: cfg.machineId }),
      },
      body: encoded as unknown as BodyInit,
    },
  };
}

async function openSignedStream(
  cfg: QoderProviderConfig,
  req: CanonicalRequest,
  deps: QoderDeps,
): Promise<{ response: Response; reader: QoderEnvelopeReader; status: number; upstreamRequestId: string | null }> {
  const modelKey = req.model.split('/').slice(1).join('/');
  const { payload } = qoderRequestPayload(req, modelKey, cfg.catalog);
  const { init } = signedInit(cfg, payload, modelKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.totalTimeoutMs);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(QODER_CHAT_URL, { ...init, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    throw new GatewayError('timeout_error', 'Qoder upstream request failed', { status: 504, cause: error });
  }
  // Headers are in: the total timeout no longer applies (Qoder streams can be long).
  clearTimeout(timer);
  if (!response.ok || !response.body) {
    throw new QoderUpstreamError(response.status, `Qoder upstream HTTP ${response.status}`);
  }
  return {
    response,
    reader: new QoderEnvelopeReader({ model: `qoder/${modelKey}` }),
    status: response.status,
    upstreamRequestId: response.headers.get('x-request-id'),
  };
}

async function drainEnvelope(
  reader: QoderEnvelopeReader,
  response: Response,
  onChunk?: (chunk: { data: string }) => void,
): Promise<void> {
  const upstream = response.body!.getReader();
  const decoder = new TextDecoder();
  let emitted = 0;
  const drain = (): boolean => {
    while (emitted < reader.chunks.length) {
      onChunk?.({ data: reader.chunks[emitted]! });
      emitted += 1;
    }
    return reader.terminal();
  };
  try {
    for (;;) {
      const part = await upstream.read();
      const done = part.done;
      reader.push(decoder.decode(part.value ?? new Uint8Array(), { stream: !done }));
      if (drain()) break;
      if (done) { reader.finish(); drain(); break; }
    }
    const error = reader.errorEnvelope();
    if (error) throw new QoderUpstreamError(error.statusValue, redactString(error.message.slice(0, 300)), error.billing);
  } finally {
    // Qoder holds the socket open after the terminal frame; leaving it un-cancelled leaks
    // the connection until the upstream keepalive gives up.
    await upstream.cancel().catch(() => {});
  }
}

/** Streaming: emit OpenAI-shaped chunks as they arrive, stop at the terminal frame. */
export async function callQoderStreaming(
  cfg: QoderProviderConfig,
  req: CanonicalRequest,
  onChunk: (chunk: { data: string }) => void,
  deps: QoderDeps = {},
): Promise<QoderCanonicalResult & { status: number; upstreamRequestId: string | null }> {
  const { response, reader, status, upstreamRequestId } = await openSignedStream(cfg, { ...req, stream: true }, deps);
  await drainEnvelope(reader, response, onChunk);
  return { status, upstreamRequestId, text: reader.text, toolCalls: reader.toolCalls, finishReason: reader.finishReason, usage: reader.usage ?? emptyUsage() };
}

/** Qoder only speaks SSE; the non-streaming shape is assembled from the same reader. */
export async function callQoderNonStreaming(
  cfg: QoderProviderConfig,
  req: CanonicalRequest,
  deps: QoderDeps = {},
): Promise<QoderCanonicalResult & { status: number; upstreamRequestId: string | null }> {
  const { response, reader, status, upstreamRequestId } = await openSignedStream(cfg, { ...req, stream: false }, deps);
  await drainEnvelope(reader, response);
  return { status, upstreamRequestId, text: reader.text, toolCalls: reader.toolCalls, finishReason: reader.finishReason, usage: reader.usage ?? emptyUsage() };
}

export async function probeQoder(cfg: QoderProviderConfig): Promise<ProbeResult> {
  const started = Date.now();
  const catalogue = cfg.catalog;
  if (!catalogue || catalogue.entries.size === 0) {
    return { ok: false, detail: 'Model catalog is empty — check the personal access token', latencyMs: Date.now() - started };
  }
  return { ok: true, detail: 'Connected (catalog loaded)', latencyMs: Date.now() - started, modelCount: catalogue.entries.size };
}

/** Catalog entries become discovered models; hidden (enable:false) keys stay routable. */
export function qoderModels(catalog: QoderCatalog): DiscoveredModel[] {
  return [...catalog.entries.values()].map((entry) => ({
    upstreamId: entry.key,
    displayName: entry.displayName,
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      reasoning: entry.isReasoning || undefined,
      image_input: entry.isVl || undefined,
      max_context_tokens: entry.maxInputTokens || null,
      max_output_tokens: entry.maxOutputTokens || null,
    },
  }));
}

export { QODER_CHAT_SIG_PATH };
