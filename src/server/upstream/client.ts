// Upstream HTTP client: streaming + non-streaming with timeouts and error normalization.

import type { Provider } from '../db/schema';
import { decryptSecret, decryptCustomHeaders } from '../auth/crypto';
import { GatewayError, clientDisconnectedError } from '../errors';
import { buildHeaders, stripSlash } from '../providers/index';
import { redactString } from '../security/redact';
import { debugUpstream, errorLine, formatError, truncate } from '../logging/debug';
import { SseFrameError, SseParser, type SseEvent } from './sse';

export interface UpstreamConfig {
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  customHeaders: Record<string, string>;
  connectTimeoutMs: number;
  firstTokenTimeoutMs: number;
  streamIdleTimeoutMs: number;
  totalTimeoutMs: number;
  /** Combo-only deadline: TTFT for streaming, full response time otherwise. */
  slowResponseTimeoutMs?: number;
  /** Request-wide abort (client disconnect or combo overall deadline). */
  requestSignal?: AbortSignal;
}

export interface UpstreamResult {
  status: number;
  body: string;
  headers: Headers;
  upstreamRequestId: string | null;
}

export function providerToUpstreamConfig(p: Provider): UpstreamConfig {
  let apiKey: string;
  let customHeaders: Record<string, string>;
  if (p.type !== 'openai' && p.type !== 'anthropic') {
    throw new GatewayError('invalid_request_error', 'Unsupported provider type', { status: 410 });
  }
  if (!p.encryptedApiKey || !p.apiKeyNonce) {
    throw new GatewayError('invalid_request_error', 'Provider credentials are missing', { status: 501 });
  }
  try {
    apiKey = decryptSecret({ ciphertext: p.encryptedApiKey, nonce: p.apiKeyNonce, version: p.apiKeyVersion });
  } catch {
    // The stored credential cannot be decrypted with the current master key
    // (e.g. LATEDEV_MASTER_KEY changed, or the DB was restored from another
    // instance). This must surface as a readable error — not an uncaught
    // MasterKeyError that Fastify wraps into an opaque 500 "Gateway error".
    throw new GatewayError('authentication_error', 'Provider credentials cannot be decrypted (master key mismatch). Re-save the provider API key.', { status: 500 });
  }
  try {
    customHeaders = decryptCustomHeaders(
      p.customHeadersEncrypted && p.customHeadersNonce
        ? { ciphertext: p.customHeadersEncrypted, nonce: p.customHeadersNonce, version: 1 }
        : null
    );
  } catch {
    throw new GatewayError('authentication_error', 'Provider custom headers cannot be decrypted (master key mismatch). Re-save the provider.', { status: 500 });
  }
  return {
    type: p.type,
    baseUrl: p.baseUrl,
    apiKey,
    customHeaders,
    connectTimeoutMs: p.connectTimeoutMs,
    firstTokenTimeoutMs: p.firstTokenTimeoutMs,
    streamIdleTimeoutMs: p.streamIdleTimeoutMs,
    totalTimeoutMs: p.totalTimeoutMs,
  };
}

export interface UpstreamCall {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
  upstreamRequestId: string | null;
  ttftMs: number | null;
}

export interface StreamChunk {
  text: string;
  isLast: boolean;
}

interface ResponseMetadata {
  upstreamStatus: number | null;
  upstreamRequestId: string | null;
  contentType: string | null;
  terminalSeen?: boolean;
}

export interface UpstreamStreamResult {
  headers: Record<string, string>;
  upstreamRequestId: string | null;
  ttftMs: number | null;
  terminalSeen: boolean;
  upstreamStatus: number;
  contentType: string | null;
}

/** Keep the original error category/code and any structured callback details. */
function withResponseMetadata(error: GatewayError, meta: ResponseMetadata, stage: string): GatewayError {
  const detail = error.cause && typeof error.cause === 'object' ? error.cause as Record<string, unknown> : {};
  return new GatewayError(error.type, error.message, {
    status: error.status, code: error.code, safe: error.safe,
    cause: {
      ...detail,
      ...meta,
      ...(meta.upstreamStatus !== null ? { status: meta.upstreamStatus } : {}),
      ...(meta.upstreamRequestId !== null ? { requestId: meta.upstreamRequestId } : {}),
      stage: typeof detail.stage === 'string' ? detail.stage : stage,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    },
  });
}

/**
 * One conversion of an upstream HTTP status into a gateway error, shared by the
 * streaming and non-streaming paths so both report identical type/code/status.
 * Before this, the same upstream 429 arrived as "Upstream rate limited" over a
 * stream and "Upstream rate limited (HTTP 429)" without one, with a different
 * code (or none) each time.
 */
export function upstreamHttpError(status: number, bodyExcerpt: string, cause?: unknown): GatewayError {
  const source = cause && typeof cause === 'object' ? cause as { retryAfterMs?: unknown; requestId?: unknown } : {};
  const detail = {
    status,
    bodyExcerpt: redactString(bodyExcerpt),
    ...(typeof source.retryAfterMs === 'number' && Number.isFinite(source.retryAfterMs) ? { retryAfterMs: source.retryAfterMs } : {}),
    ...(typeof source.requestId === 'string' ? { requestId: source.requestId } : {}),
  };
  if (status >= 500) return new GatewayError('upstream_error', `Upstream HTTP ${status}`, { status: 502, cause: detail, code: `upstream_http_${status}` });
  // Keep the body on a 429: it distinguishes a transient throttle from exhausted upstream quota.
  // `isQuotaFailure` matches on that wording. Callers pass an already-redacted excerpt.
  if (status === 429) return new GatewayError('upstream_rate_limit', `Upstream rate limited (HTTP ${status})${detail.bodyExcerpt ? `: ${detail.bodyExcerpt}` : ''}`, { status: 429, cause: detail, code: 'upstream_http_429' });
  if (status === 401 || status === 403) return new GatewayError('upstream_auth_error', `Upstream authentication failed (HTTP ${status})`, { status: 502, cause: detail, code: `upstream_http_${status}` });
  return new GatewayError('upstream_error', `Upstream HTTP ${status}: ${detail.bodyExcerpt}`, { status: 502, cause: detail, code: `upstream_http_${status}` });
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestAbortError(signal: AbortSignal, cause?: unknown): GatewayError {
  return signal.reason instanceof GatewayError ? signal.reason : clientDisconnectedError(cause);
}

export async function callUpstreamNonStreaming(cfg: UpstreamConfig, url: string, payload: unknown, requestId = '-'): Promise<UpstreamCall> {
  const ctl = new AbortController();
  const start = performance.now();
  let headersReceived = false;
  let responseStatus: number | null = null;
  let upstreamRequestId: string | null = null;
  let contentType: string | null = null;
  const enrichError = (error: GatewayError, stage: string) => withResponseMetadata(error, {
    upstreamStatus: responseStatus, upstreamRequestId, contentType,
  }, stage);
  let responseRetryAfter: number | undefined;
  const abortReason: { value: 'connect' | 'slow_response' | 'total' | 'request' } = { value: 'total' };
  let aborted = false;
  const abortWithReason = (reason: 'connect' | 'slow_response' | 'total' | 'request') => {
    if (aborted) return;
    aborted = true;
    abortReason.value = reason;
    ctl.abort();
  };
  const handleRequestAbort = () => abortWithReason('request');
  if (cfg.requestSignal?.aborted) handleRequestAbort();
  else cfg.requestSignal?.addEventListener('abort', handleRequestAbort, { once: true });
  const connectTimer = setTimeout(() => {
    if (!headersReceived) {
      abortWithReason('connect');
    }
  }, Math.max(0, start + cfg.connectTimeoutMs - performance.now()));
  const totalTimer = setTimeout(() => abortWithReason('total'), Math.max(0, start + cfg.totalTimeoutMs - performance.now()));
  const softLimit = cfg.slowResponseTimeoutMs;
  const slowResponseTimer = softLimit === undefined || softLimit >= cfg.totalTimeoutMs
    ? null
    : setTimeout(() => {
      const now = performance.now();
      if (now >= start + cfg.totalTimeoutMs) abortWithReason('total');
      else if (!headersReceived && now >= start + cfg.connectTimeoutMs) abortWithReason('connect');
      else abortWithReason('slow_response');
    }, Math.max(0, start + softLimit - performance.now()));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders({ ...cfg, apiKey: cfg.apiKey ?? '' }), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    responseStatus = res.status;
    upstreamRequestId = extractUpstreamRequestId(res.headers);
    contentType = res.headers.get('content-type');
    if (performance.now() >= start + cfg.connectTimeoutMs) {
      abortWithReason('connect');
      throw new DOMException('Connect deadline exceeded', 'AbortError');
    }
    responseRetryAfter = retryAfterMs(res.headers.get('retry-after'));
    headersReceived = true;
    clearTimeout(connectTimer);
    if (!res.ok && slowResponseTimer) clearTimeout(slowResponseTimer);
    const text = await res.text();
    if (cfg.requestSignal?.aborted) throw requestAbortError(cfg.requestSignal);
    if (res.ok && (aborted || performance.now() >= start + cfg.totalTimeoutMs || (slowResponseTimer && softLimit !== undefined && performance.now() >= start + softLimit))) {
      if (performance.now() >= start + cfg.totalTimeoutMs) abortWithReason('total');
      else abortWithReason('slow_response');
      throw new DOMException('Response deadline exceeded', 'AbortError');
    }
    const ttft = Math.round(performance.now() - start);
    logUpstreamResponse(requestId, res.status, res.statusText, res.headers, ttft, text);
    return {
      status: res.status,
      ok: res.ok,
      text,
      headers: Object.fromEntries(res.headers.entries()),
      upstreamRequestId,
      ttftMs: ttft,
    };
  } catch (e) {
    const err = e as Error;
    if (cfg.requestSignal?.aborted) throw enrichError(requestAbortError(cfg.requestSignal, e), 'request');
    errorLine(requestId, 'UPSTREAM FETCH ERROR', [`url=${url}`, `afterMs=${Math.round(performance.now() - start)}`, ...formatError(e)]);
    // A known non-2xx status remains the fallback signal even if its error body
    // stalls until the provider total deadline. The deadline still aborts the read.
    if (responseStatus !== null && (responseStatus < 200 || responseStatus >= 300)) {
      throw enrichError(upstreamHttpError(responseStatus, '', { status: responseStatus, retryAfterMs: responseRetryAfter, requestId: upstreamRequestId }), 'http_status');
    }
    if (aborted || err.name === 'AbortError') {
      if (abortReason.value === 'connect') {
        throw enrichError(new GatewayError('timeout_error', 'Upstream connect timeout', { status: 504, code: 'upstream_connect_timeout', cause: e }), 'connect');
      }
      if (abortReason.value === 'slow_response') {
        throw enrichError(new GatewayError('timeout_error', 'Combo slow response threshold exceeded', { status: 504, code: 'combo_slow_response_timeout', cause: e }), 'slow_response');
      }
      throw enrichError(new GatewayError('timeout_error', 'Upstream total timeout', { status: 504, code: 'upstream_total_timeout', cause: e }), 'total');
    }
    throw enrichError(new GatewayError('upstream_unavailable', `Upstream connection failed: ${err.message}`, { status: 502, cause: e }), headersReceived ? 'read_body' : 'connect');
  } finally {
    cfg.requestSignal?.removeEventListener('abort', handleRequestAbort);
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    if (slowResponseTimer) clearTimeout(slowResponseTimer);
  }
}

export function extractUpstreamRequestId(headers: Headers | Record<string, string>): string | null {
  if (headers instanceof Headers) {
    return headers.get('x-request-id') ?? headers.get('request-id') ?? headers.get('x-amzn-requestid') ?? null;
  }
  return headers['x-request-id'] ?? headers['request-id'] ?? headers['x-amzn-requestid'] ?? null;
}

/** docs/13 §14: upstream response summary (sanitized headers) + error body for non-2xx. */
function logUpstreamResponse(requestId: string, status: number, statusText: string, headers: Headers, durationMs: number, body: string): void {
  const h = (name: string): string | undefined => headers.get(name) ?? undefined;
  debugUpstream(requestId, 'UPSTREAM RESPONSE', [
    `status=${status}`,
    `statusText=${statusText}`,
    `content-type=${h('content-type') ?? 'undefined'}`,
    `content-length=${h('content-length') ?? 'undefined'}`,
    `transfer-encoding=${h('transfer-encoding') ?? 'undefined'}`,
    `server=${h('server') ?? 'undefined'}`,
    `durationToHeadersMs=${durationMs}`,
    `upstreamRequestId=${extractUpstreamRequestId(headers) ?? 'null'}`,
  ]);
  if (status < 200 || status >= 300) {
    errorLine(requestId, 'UPSTREAM ERROR BODY', [redactString(truncate(body, 4000))]);
  }
}

/**
 * Call upstream with SSE streaming. Invokes onChunk for each SSE event.
 * Returns a promise resolving when the stream completes or rejects on failure.
 */
export async function callUpstreamStreaming(
  cfg: UpstreamConfig,
  url: string,
  payload: unknown,
  onChunk: (event: { data: string; event?: string }, isFirst: boolean) => boolean | void,
  requestId = '-',
  requestStartMs = Date.now(),
  downstreamSignal?: AbortSignal,
): Promise<UpstreamStreamResult> {
  const ctl = new AbortController();
  // Keep the caller's dispatch origin for compatibility, then measure elapsed
  // time on a monotonic clock (wall-clock corrections cannot extend deadlines).
  const start = performance.now() - Math.max(0, Date.now() - requestStartMs);
  let ttft: number | null = null;
  // Which watchdog aborted, so the error names the limit that was actually hit.
  const abortReason: { value: 'connect' | 'total' | 'idle' | 'first_token' | 'slow_response' | 'downstream' | 'request' } = { value: 'total' };
  let aborted = false;
  const abortWithReason = (reason: 'connect' | 'total' | 'idle' | 'first_token' | 'slow_response' | 'downstream' | 'request') => {
    if (aborted) return;
    aborted = true;
    abortReason.value = reason;
    ctl.abort();
  };
  const handleDownstreamAbort = () => abortWithReason('downstream');
  if (downstreamSignal?.aborted) handleDownstreamAbort();
  else downstreamSignal?.addEventListener('abort', handleDownstreamAbort, { once: true });
  const handleRequestAbort = () => abortWithReason('request');
  if (cfg.requestSignal?.aborted) handleRequestAbort();
  else cfg.requestSignal?.addEventListener('abort', handleRequestAbort, { once: true });
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let headersReceived = false;
  let responseStatus: number | null = null;
  let upstreamRequestId: string | null = null;
  let contentType: string | null = null;
  let terminalSeen = false;
  let stage = 'connect';
  const enrichError = (error: GatewayError, errorStage = stage) => withResponseMetadata(error, {
    upstreamStatus: responseStatus, upstreamRequestId, contentType, terminalSeen,
  }, errorStage);
  let responseRetryAfter: number | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const totalTimer = setTimeout(() => abortWithReason('total'), Math.max(0, start + cfg.totalTimeoutMs - performance.now()));
  const connectTimer = setTimeout(() => {
    if (!headersReceived) {
      abortWithReason('connect');
    }
  }, Math.max(0, start + cfg.connectTimeoutMs - performance.now()));
  let firstTokenDeadline = Infinity;
  let idleDeadline = Infinity;
  const softLimit = cfg.slowResponseTimeoutMs;
  const slowResponseTimer = softLimit === undefined || softLimit >= cfg.totalTimeoutMs
    ? null
    : setTimeout(() => {
      const now = performance.now();
      // A hard watchdog wins if its deadline is reached at the same time.
      if (now >= start + cfg.totalTimeoutMs) abortWithReason('total');
      else if (!headersReceived && now >= start + cfg.connectTimeoutMs) abortWithReason('connect');
      else if (now >= firstTokenDeadline) abortWithReason('first_token');
      else if (now >= idleDeadline) abortWithReason('idle');
      else abortWithReason('slow_response');
    }, Math.max(0, start + softLimit - performance.now()));

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleDeadline = performance.now() + cfg.streamIdleTimeoutMs;
    idleTimer = setTimeout(() => abortWithReason('idle'), cfg.streamIdleTimeoutMs);
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders({ ...cfg, apiKey: cfg.apiKey ?? '' }), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    responseStatus = res.status;
    upstreamRequestId = extractUpstreamRequestId(res.headers);
    contentType = res.headers.get('content-type');
    if (performance.now() >= start + cfg.connectTimeoutMs) {
      abortWithReason('connect');
      throw new DOMException('Connect deadline exceeded', 'AbortError');
    }
    responseRetryAfter = retryAfterMs(res.headers.get('retry-after'));
    headersReceived = true;
    clearTimeout(connectTimer);
    if (!res.ok) {
      stage = 'http_status';
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (slowResponseTimer) clearTimeout(slowResponseTimer);
      const text = await res.text();
      logUpstreamResponse(requestId, res.status, res.statusText, res.headers, Math.round(performance.now() - start), text);
      throw new UpstreamHttpError(res.status, text, upstreamRequestId, responseRetryAfter);
    }
    logUpstreamResponse(requestId, res.status, res.statusText, res.headers, Math.round(performance.now() - start), '');
    reader = res.body?.getReader() ?? null;
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    const jsonCompletion = cfg.type === 'openai' && (mediaType === 'application/json' || Boolean(mediaType?.startsWith('application/') && mediaType.endsWith('+json')));
    if (mediaType !== 'text/event-stream' && !jsonCompletion) {
      stage = 'unexpected_content_type';
      throw new GatewayError('upstream_error', 'Upstream returned a non-SSE response for a streaming request', { status: 502, code: 'upstream_bad_response' });
    }
    if (!reader) {
      stage = 'missing_body';
      throw new GatewayError('upstream_error', 'Upstream streaming response has no body', { status: 502, code: 'upstream_bad_response' });
    }
    // Provider first-token timeout keeps its original post-headers semantics. The combo watchdog
    // above is separate and measures request start through the first actual content token.
    firstTokenDeadline = performance.now() + cfg.firstTokenTimeoutMs;
    firstTokenTimer = setTimeout(() => abortWithReason('first_token'), cfg.firstTokenTimeoutMs);
    resetIdle();

    const parser = new SseParser();
    let isFirst = true;
    const checkDeadlines = () => {
      const now = performance.now();
      if (now >= start + cfg.totalTimeoutMs) abortWithReason('total');
      else if (now >= firstTokenDeadline) abortWithReason('first_token');
      else if (now >= idleDeadline) abortWithReason('idle');
      else if (ttft === null && slowResponseTimer && softLimit !== undefined && now >= start + softLimit) abortWithReason('slow_response');
      if (aborted) throw new DOMException('Stream deadline exceeded', 'AbortError');
    };
    const processEvent = (event: SseEvent) => {
      checkDeadlines();
      if (cfg.type === 'openai' && event.event !== 'json' && event.data === '[DONE]') {
        terminalSeen = true;
        return;
      }
      if (cfg.type === 'anthropic' && (event.event === 'message_stop' || event.event === 'message')) {
        // Some compatible servers omit event:; require the actual typed JSON
        // message_stop, not an unverified event label, before terminating.
        try { terminalSeen = JSON.parse(event.data)?.type === 'message_stop'; } catch { /* callback validates JSON */ }
      }
      stage = 'chunk_callback';
      const meaningfulOutput = onChunk(event, isFirst);
      if (meaningfulOutput && ttft === null) {
        ttft = Math.round(performance.now() - start);
        firstTokenDeadline = Infinity;
        if (firstTokenTimer) clearTimeout(firstTokenTimer);
        if (slowResponseTimer) clearTimeout(slowResponseTimer);
      }
      isFirst = false;
      stage = 'sse_frame';
    };
    if (jsonCompletion) {
      // A compatible OpenAI upstream may ignore stream=true. This is already a
      // non-streaming response: buffer only this bounded JSON body and let the
      // runner validate/normalize the complete message into one delta.
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const parts: string[] = [];
      let bytes = 0;
      while (true) {
        stage = 'read_json';
        const part = await reader.read();
        checkDeadlines();
        if (part.done) break;
        if (!part.value.byteLength) continue;
        bytes += part.value.byteLength;
        if (bytes > 1024 * 1024) {
          stage = 'json_body_limit';
          throw new GatewayError('upstream_error', 'Upstream JSON completion exceeds 1 MiB', { status: 502, code: 'upstream_bad_response' });
        }
        resetIdle();
        try { parts.push(decoder.decode(part.value, { stream: true })); }
        catch { stage = 'invalid_json_utf8'; throw new GatewayError('upstream_error', 'Upstream JSON completion contains invalid UTF-8', { status: 502, code: 'upstream_bad_response' }); }
      }
      try { parts.push(decoder.decode()); }
      catch { stage = 'invalid_json_utf8'; throw new GatewayError('upstream_error', 'Upstream JSON completion contains invalid UTF-8', { status: 502, code: 'upstream_bad_response' }); }
      processEvent({ event: 'json', data: parts.join('') });
      terminalSeen = true;
    } else {
      while (!terminalSeen) {
        stage = 'read_stream';
        const part = await reader.read();
        checkDeadlines();
        stage = 'sse_frame';
        if (part.done) {
          parser.finish();
          break;
        }
        if (part.value.byteLength) resetIdle(); // Wire activity, including comments; never clears TTFT.
        for (const event of parser.push(part.value)) {
          processEvent(event);
          if (terminalSeen) break;
        }
      }
    }
    if (cfg.requestSignal?.aborted) throw requestAbortError(cfg.requestSignal);
    if (downstreamSignal?.aborted) throw clientDisconnectedError();
    checkDeadlines();
    // Stop reading at the authoritative terminal marker. Some upstreams leave
    // the socket open, and an underlying cancel() may itself never settle.
    if (terminalSeen && !jsonCompletion) void reader.cancel().catch(() => undefined);
    return {
      headers: Object.fromEntries(res.headers.entries()),
      upstreamRequestId,
      ttftMs: ttft,
      terminalSeen,
      upstreamStatus: res.status,
      contentType,
    };
  } catch (e) {
    const watchdogAborted = aborted;
    // Abort transport on failure without waiting for a stalled cancel handshake.
    if (reader) void reader.cancel().catch(() => undefined);
    if (!aborted) ctl.abort();
    if (cfg.requestSignal?.aborted) throw enrichError(requestAbortError(cfg.requestSignal, e), 'request');
    if (downstreamSignal?.aborted || abortReason.value === 'downstream') {
      throw enrichError(new GatewayError('gateway_error', 'Downstream client disconnected', {
        status: 499,
        code: 'client_disconnected',
        cause: e,
      }), 'downstream');
    }
    if (e instanceof UpstreamHttpError) {
      throw enrichError(upstreamHttpError(e.status, e.bodyExcerpt, e), 'http_status');
    }
    // Preserve a known HTTP error status when the provider stalls while sending
    // its body. Total timeout still bounds the read, but status-based combo
    // switches (408/429/5xx) remain authoritative once headers have arrived.
    if (responseStatus !== null && (responseStatus < 200 || responseStatus >= 300)) {
      throw enrichError(upstreamHttpError(responseStatus, '', { status: responseStatus, retryAfterMs: responseRetryAfter, requestId: upstreamRequestId }), 'http_status');
    }
    if (e instanceof SseFrameError) {
      throw enrichError(new GatewayError('upstream_error', e.message, { status: 502, code: 'upstream_bad_response' }), e.stage);
    }
    if (e instanceof GatewayError) throw enrichError(e);
    const err = e as Error;
    errorLine(requestId, 'UPSTREAM FETCH ERROR', [
      `url=${url}`,
      `afterMs=${Math.round(performance.now() - start)}`,
      `ttftKnown=${ttft !== null}`,
      ...formatError(e),
    ]);
    if (watchdogAborted || err.name === 'AbortError') {
      if (abortReason.value === 'connect') {
        throw enrichError(new GatewayError('timeout_error', 'Upstream connect timeout', { status: 504, code: 'upstream_connect_timeout', cause: e }), 'connect');
      }
      if (abortReason.value === 'slow_response') {
        throw enrichError(new GatewayError('timeout_error', 'Combo slow response threshold exceeded before first token', { status: 504, code: 'combo_slow_response_timeout', cause: e }), 'slow_response');
      }
      if (abortReason.value === 'total') {
        throw enrichError(new GatewayError('timeout_error', 'Upstream total timeout', { status: 504, code: 'upstream_total_timeout', cause: e }), 'total');
      }
      if (abortReason.value === 'first_token' && ttft === null) {
        throw enrichError(new GatewayError('timeout_error', 'Upstream first token timeout', { status: 504, code: 'upstream_first_token_timeout', cause: e }), 'first_token');
      }
      if (abortReason.value === 'idle' && ttft === null) {
        throw enrichError(new GatewayError('timeout_error', 'Upstream first token timeout (stream idle)', { status: 504, code: 'upstream_first_token_timeout', cause: e }), 'idle');
      }
      throw enrichError(new GatewayError('timeout_error', 'Upstream stream idle timeout', { status: 504, code: 'upstream_stream_idle_timeout', cause: e }), 'idle');
    }
    throw enrichError(new GatewayError('upstream_unavailable', `Upstream connection failed: ${err.message}`, { status: 502, cause: e }));
  } finally {
    cfg.requestSignal?.removeEventListener('abort', handleRequestAbort);
    downstreamSignal?.removeEventListener('abort', handleDownstreamAbort);
    clearTimeout(totalTimer);
    clearTimeout(connectTimer);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    if (slowResponseTimer) clearTimeout(slowResponseTimer);
    if (idleTimer) clearTimeout(idleTimer);
    try { reader?.releaseLock(); } catch { /* stream reader already released */ }
  }
}

export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly requestId: string | null,
    readonly retryAfterMs?: number
  ) {
    super(`Upstream HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
  get bodyExcerpt(): string {
    return this.body.slice(0, 500);
  }
}

export function upstreamUrl(cfg: UpstreamConfig, path: string): string {
  return `${stripSlash(cfg.baseUrl)}${path.startsWith('/') ? path : '/' + path}`;
}
