// Native Codex Responses SSE: preserve item IDs, tool calls and event ordering.
import { GatewayError } from '../errors';
import { CODEX_API_PATH, CODEX_ORIGIN } from '../providers/integration';
import { tokenCount } from '../protocols/canonical';
import { callUpstreamStreaming, type UpstreamConfig } from '../upstream/client';
import type { GatewayContext, UsageSummary } from './runner';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const bad = (message: string) => new GatewayError('upstream_error', message, { status: 502, code: 'upstream_bad_response' });
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// These native events carry output that makes replay unsafe. Reasoning is
// visible output too, but only a valid terminal answer or tool call can succeed.
const outputDeltas = new Set([
  'response.output_text.delta', 'response.refusal.delta',
  'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta',
  'response.reasoning_text.delta', 'response.reasoning_summary_text.delta',
]);

function isToolCall(item: Json): item is Json & { call_id: string; name: string } {
  return (item.type === 'function_call' || item.type === 'custom_tool_call') && nonblank(item.call_id) && nonblank(item.name);
}

function validFunctionArguments(value: unknown): value is string {
  if (!nonblank(value)) return false;
  try {
    const args: unknown = JSON.parse(value);
    return args !== null && typeof args === 'object' && !Array.isArray(args);
  } catch { return false; }
}

export function validateCodexRequest(body: Json): void {
  if (body.stream !== true || !Array.isArray(body.input) || body.store === true || body.previous_response_id != null || body.max_output_tokens != null || body.background === true) {
    throw new GatewayError('invalid_request_error', 'Codex HTTP requires stream=true, replayed input, store=false, and no previous_response_id, background or max_output_tokens', { status: 400, code: 'unsupported_codex_request' });
  }
}

export function hasCodexTokenCap(key: { tpmLimit: number | null; dailyTokenLimit: number | null; monthlyTokenLimit: number | null; totalTokenLimit: number | null; maxOutputTokensPerRequest: number | null }): boolean {
  return [key.tpmLimit, key.dailyTokenLimit, key.monthlyTokenLimit, key.totalTokenLimit, key.maxOutputTokensPerRequest].some(n => n != null);
}

export async function runCodexStreaming(
  body: Json, upstreamModel: string, cfg: UpstreamConfig, ctx: GatewayContext,
  onStreamStart: (started: boolean) => void, onFirstToken: (ttftMs: number) => void,
) {
  const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  const pipe = ctx.reply.raw;
  const start = performance.now();
  let committed = false;
  let terminal = false;
  let preludeBytes = 0;
  let pending: string[] = [];
  let text = '';
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const payload = { ...body, model: upstreamModel, stream: true, store: false };
  delete (payload as Json).previous_response_id;
  delete (payload as Json).max_output_tokens;
  const emit = (s: string, commitOutput: boolean) => {
    if (!committed && !commitOutput) {
      preludeBytes += Buffer.byteLength(s);
      if (preludeBytes > 2 * 1024 * 1024) throw bad('Codex metadata exceeds the pre-stream buffer limit');
      pending.push(s);
      return;
    }
    if (!committed) {
      pipe.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', 'x-request-id': ctx.requestId, 'x-accel-buffering': 'no' });
      committed = true;
      onStreamStart(true);
      onFirstToken(Math.round(performance.now() - start));
      for (const item of pending) pipe.write(item);
      pending = [];
    }
    pipe.write(s);
  };
  try {
    const meta = await callUpstreamStreaming(cfg, `${CODEX_ORIGIN}${CODEX_API_PATH}/responses`, payload, event => {
      let obj: Json;
      try { obj = record(JSON.parse(event.data)); } catch { throw bad('Invalid Codex SSE JSON'); }
      const type = obj.type;
      if (typeof type !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(type) || (event.event && event.event !== 'message' && event.event !== type)) throw bad('Invalid Codex SSE event type');
      const response = record(obj.response);
      const rawUsage = record(response.usage);
      usage.input = tokenCount(rawUsage.input_tokens, usage.input);
      usage.output = tokenCount(rawUsage.output_tokens, usage.output);
      usage.cacheRead = tokenCount(record(rawUsage.input_tokens_details).cached_tokens, usage.cacheRead);
      usage.reasoning = tokenCount(record(rawUsage.output_tokens_details).reasoning_tokens, usage.reasoning);
      usage.total = tokenCount(rawUsage.total_tokens, usage.input + usage.output);
      if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
        // Error payloads may contain sensitive provider context. Never reflect raw
        // errors into the logs or synthesize a successful terminal event.
        throw bad('Codex upstream reported an unsuccessful response');
      }
      const item = record(obj.item);
      let commitOutput = (outputDeltas.has(type) && typeof obj.delta === 'string' && obj.delta.length > 0) ||
        (type === 'response.output_item.added' && isToolCall(item));
      if (type === 'response.completed') {
        if (response.status !== 'completed' || !Array.isArray(response.output)) throw bad('Invalid Codex completion');
        for (const entry of response.output) {
          const output = record(entry);
          if (output.type === 'message' && Array.isArray(output.content)) {
            for (const part of output.content) {
              const p = record(part);
              if (p.type === 'output_text' && nonblank(p.text)) text += p.text;
              if (p.type === 'refusal' && nonblank(p.refusal)) text += p.refusal;
            }
          } else if (output.type === 'function_call' || output.type === 'custom_tool_call') {
            const input = output.type === 'function_call' ? output.arguments : output.input;
            if (!isToolCall(output) || (output.status !== undefined && output.status !== 'completed') ||
                (output.type === 'function_call' ? !validFunctionArguments(input) : typeof input !== 'string')) {
              throw bad('Invalid Codex terminal tool call');
            }
            toolCalls.push({ id: output.call_id, name: output.name, input });
          }
        }
        // Prior wire commitment cannot certify an otherwise empty completion.
        if (!text && !toolCalls.length) throw bad('Codex completed without deliverable content');
        commitOutput = true;
        terminal = true;
      }
      // Preserve native protocol events and response/item identifiers. The
      // only model rewriting is the configured upstream model in the request.
      emit(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`, commitOutput);
      return commitOutput;
    }, ctx.requestId);
    if (!terminal || !meta.terminalSeen) throw bad('Codex stream ended without response.completed');
    pipe.end();
    return { statusCode: meta.upstreamStatus, ttftMs: meta.ttftMs, upstreamRequestId: meta.upstreamRequestId, usage, result: { text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' } };
  } catch (e) {
    const error = e instanceof GatewayError ? e : bad('Codex response processing failed');
    if (committed && !pipe.writableEnded && !pipe.destroyed) {
      if (!terminal && error.code !== 'client_disconnected') {
        pipe.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code: 'codex_upstream_failed', message: 'Codex response did not complete' })}\n\n`);
      }
      pipe.end();
    }
    const cause = record(error.cause);
    throw new GatewayError(error.type, error.message, { status: error.status, code: error.code, cause: {
      usage, status: cause.status, upstreamStatus: cause.upstreamStatus, upstreamRequestId: cause.upstreamRequestId, retryAfterMs: cause.retryAfterMs,
    } });
  }
}
