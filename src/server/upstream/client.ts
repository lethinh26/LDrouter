// Upstream HTTP client: streaming + non-streaming with timeouts and error normalization.

import type { Provider } from '../db/schema';
import { decryptSecret, decryptCustomHeaders } from '../auth/crypto';
import { GatewayError } from '../errors';
import { buildHeaders, stripSlash } from '../providers/index';
import { redactString } from '../security/redact';
import { debugUpstream, errorLine, formatError, truncate } from '../logging/debug';

export interface UpstreamConfig {
  type: 'openai' | 'anthropic' | 'codex' | 'qoder';
  baseUrl: string;
  apiKey?: string;
  customHeaders: Record<string, string>;
  connectTimeoutMs: number;
  firstTokenTimeoutMs: number;
  streamIdleTimeoutMs: number;
  totalTimeoutMs: number;
  /** Combo-only deadline: TTFT for streaming, full response time otherwise. */
  slowResponseTimeoutMs?: number;
  codexAccountId?: string;
  qoderUserId?: string;
  qoderAccountRecordId?: string;
  accountRecordId?: string;
}

export interface UpstreamResult {
  status: number;
  body: string;
  headers: Headers;
  upstreamRequestId: string | null;
}

export function providerToUpstreamConfig(p: Provider, _codexAccountId?: string): UpstreamConfig {
  let apiKey: string;
  let customHeaders: Record<string, string>;
  if (p.type === 'codex' || p.type === 'qoder') {
    throw new GatewayError('invalid_request_error', `${p.type} providers are no longer supported`, { status: 410 });
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

/**
 * One conversion of an upstream HTTP status into a gateway error, shared by the
 * streaming and non-streaming paths so both report identical type/code/status.
 * Before this, the same upstream 429 arrived as "Upstream rate limited" over a
 * stream and "Upstream rate limited (HTTP 429)" without one, with a different
 * code (or none) each time.
 */
export function upstreamHttpError(status: number, bodyExcerpt: string, cause?: unknown): GatewayError {
  if (status >= 500) return new GatewayError('upstream_error', `Upstream HTTP ${status}`, { status: 502, cause, code: `upstream_http_${status}` });
  // Keep the body on a 429: it is the only place a provider says *why*, and the wording decides
  // whether this is a transient throttle (retry) or an exhausted account (disable it and move on).
  // `isQuotaFailure` matches on that wording. Callers pass an already-redacted excerpt.
  if (status === 429) return new GatewayError('upstream_rate_limit', `Upstream rate limited (HTTP ${status})${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`, { status: 429, cause, code: 'upstream_http_429' });
  if (status === 401 || status === 403) return new GatewayError('upstream_auth_error', `Upstream authentication failed (HTTP ${status})`, { status: 502, cause, code: `upstream_http_${status}` });
  return new GatewayError('upstream_error', `Upstream HTTP ${status}: ${bodyExcerpt}`, { status: 502, cause, code: `upstream_http_${status}` });
}

export async function callUpstreamNonStreaming(cfg: UpstreamConfig, url: string, payload: unknown, requestId = '-'): Promise<UpstreamCall> {
  const ctl = new AbortController();
  const start = Date.now();
  let headersReceived = false;
  let responseStatus: number | null = null;
  const abortReason: { value: 'connect' | 'slow_response' | 'total' } = { value: 'total' };
  let aborted = false;
  const abortWithReason = (reason: 'connect' | 'slow_response' | 'total') => {
    if (aborted) return;
    aborted = true;
    abortReason.value = reason;
    ctl.abort();
  };
  const connectTimer = setTimeout(() => {
    if (!headersReceived) {
      abortWithReason('connect');
    }
  }, Math.max(0, start + cfg.connectTimeoutMs - Date.now()));
  const totalTimer = setTimeout(() => abortWithReason('total'), Math.max(0, start + cfg.totalTimeoutMs - Date.now()));
  const slowResponseTimer = cfg.slowResponseTimeoutMs === undefined
    ? null
    : setTimeout(() => abortWithReason('slow_response'), Math.max(0, start + cfg.slowResponseTimeoutMs - Date.now()));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders({ ...cfg, apiKey: cfg.apiKey ?? '' }), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    responseStatus = res.status;
    headersReceived = true;
    clearTimeout(connectTimer);
    if (!res.ok && slowResponseTimer) clearTimeout(slowResponseTimer);
    const text = await res.text();
    const ttft = Date.now() - start;
    logUpstreamResponse(requestId, res.status, res.statusText, res.headers, ttft, text);
    return {
      status: res.status,
      ok: res.ok,
      text,
      headers: Object.fromEntries(res.headers.entries()),
      upstreamRequestId: extractUpstreamRequestId(res.headers),
      ttftMs: ttft,
    };
  } catch (e) {
    const err = e as Error;
    errorLine(requestId, 'UPSTREAM FETCH ERROR', [`url=${url}`, `afterMs=${Date.now() - start}`, ...formatError(e)]);
    // A known non-2xx status remains the fallback signal even if its error body
    // stalls until the provider total deadline. The deadline still aborts the read.
    if (responseStatus !== null && (responseStatus < 200 || responseStatus >= 300)) {
      throw upstreamHttpError(responseStatus, '', { status: responseStatus, cause: e });
    }
    if (err.name === 'AbortError') {
      if (abortReason.value === 'connect') {
        throw new GatewayError('timeout_error', 'Upstream connect timeout', { status: 504, code: 'upstream_connect_timeout', cause: e });
      }
      if (abortReason.value === 'slow_response') {
        throw new GatewayError('timeout_error', 'Combo slow response threshold exceeded', { status: 504, code: 'combo_slow_response_timeout', cause: e });
      }
      throw new GatewayError('timeout_error', 'Upstream total timeout', { status: 504, code: 'upstream_total_timeout', cause: e });
    }
    throw new GatewayError('upstream_unavailable', `Upstream connection failed: ${err.message}`, { status: 502, cause: e });
  } finally {
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
): Promise<{ headers: Record<string, string>; upstreamRequestId: string | null; ttftMs: number | null }> {
  const ctl = new AbortController();
  const start = requestStartMs;
  let ttft: number | null = null;
  // Which watchdog aborted, so the error names the limit that was actually hit.
  const abortReason: { value: 'connect' | 'total' | 'idle' | 'first_token' | 'slow_response' | 'downstream' } = { value: 'total' };
  let aborted = false;
  const abortWithReason = (reason: 'connect' | 'total' | 'idle' | 'first_token' | 'slow_response' | 'downstream') => {
    if (aborted) return;
    aborted = true;
    abortReason.value = reason;
    ctl.abort();
  };
  const handleDownstreamAbort = () => abortWithReason('downstream');
  if (downstreamSignal?.aborted) handleDownstreamAbort();
  else downstreamSignal?.addEventListener('abort', handleDownstreamAbort, { once: true });
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
  const slowResponseTimer = cfg.slowResponseTimeoutMs === undefined
    ? null
    : setTimeout(
      () => abortWithReason('slow_response'),
      Math.max(0, start + cfg.slowResponseTimeoutMs - Date.now()),
    );
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let headersReceived = false;
  let responseStatus: number | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const totalTimer = setTimeout(() => abortWithReason('total'), Math.max(0, start + cfg.totalTimeoutMs - Date.now()));
  const connectTimer = setTimeout(() => {
    if (!headersReceived) {
      abortWithReason('connect');
    }
  }, Math.max(0, start + cfg.connectTimeoutMs - Date.now()));

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
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
    headersReceived = true;
    clearTimeout(connectTimer);
    if (!res.ok || !res.body) {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (slowResponseTimer) clearTimeout(slowResponseTimer);
      const text = await res.text();
      logUpstreamResponse(requestId, res.status, res.statusText, res.headers, Date.now() - start, text);
      throw new UpstreamHttpError(res.status, text, extractUpstreamRequestId(res.headers));
    }
    logUpstreamResponse(requestId, res.status, res.statusText, res.headers, Date.now() - start, '');
    // Provider first-token timeout keeps its original post-headers semantics. The combo watchdog
    // above is separate and measures request start through the first actual content token.
    firstTokenTimer = setTimeout(() => abortWithReason('first_token'), cfg.firstTokenTimeoutMs);
    resetIdle();

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isFirst = true;
    let streamDone = false;
    const processEvent = (rawEvent: string) => {
      const lines = rawEvent.split(/\r?\n/);
      let data = '';
      let event = 'message';
      for (const line of lines) {
        if (line.startsWith('data:')) data = line.slice(5).trimStart();
        else if (line.startsWith('event:')) event = line.slice(6).trimStart();
      }
      if (data === '[DONE]') return;
      if (data) {
        resetIdle();
        const meaningfulOutput = onChunk({ data, event }, isFirst);
        if (meaningfulOutput && ttft === null) {
          ttft = Date.now() - start;
          if (firstTokenTimer) clearTimeout(firstTokenTimer);
          if (slowResponseTimer) clearTimeout(slowResponseTimer);
        }
        isFirst = false;
      }
    };
    while (!streamDone) {
      const part = await reader.read();
      streamDone = part.done;
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: streamDone });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const separatorLength = buffer[idx] === '\r' ? 4 : 2;
        processEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + separatorLength);
      }
    }
    if (buffer.trim()) processEvent(buffer.replace(/\r?\n$/, ''));
    return {
      headers: Object.fromEntries(res.headers.entries()),
      upstreamRequestId: extractUpstreamRequestId(res.headers),
      ttftMs: ttft,
    };
  } catch (e) {
    if (reader) {
      if (!aborted) abortWithReason(e instanceof GatewayError && e.code === 'combo_slow_response_timeout' ? 'slow_response' : 'total');
      await reader.cancel(e).catch(() => undefined);
    }
    if (downstreamSignal?.aborted || abortReason.value === 'downstream') {
      throw new GatewayError('gateway_error', 'Downstream client disconnected', {
        status: 499,
        code: 'client_disconnected',
        cause: e,
      });
    }
    if (e instanceof UpstreamHttpError) {
      throw upstreamHttpError(e.status, e.bodyExcerpt, e);
    }
    // Preserve a known HTTP error status when the provider stalls while sending
    // its body. Total timeout still bounds the read, but status-based combo
    // switches (408/429/5xx) remain authoritative once headers have arrived.
    if (responseStatus !== null && (responseStatus < 200 || responseStatus >= 300)) {
      throw upstreamHttpError(responseStatus, '', { status: responseStatus, cause: e });
    }
    if (e instanceof GatewayError) throw e;
    const err = e as Error;
    errorLine(requestId, 'UPSTREAM FETCH ERROR', [
      `url=${url}`,
      `afterMs=${Date.now() - start}`,
      `ttftKnown=${ttft !== null}`,
      ...formatError(e),
    ]);
    if (err.name === 'AbortError') {
      if (abortReason.value === 'connect') {
        throw new GatewayError('timeout_error', 'Upstream connect timeout', { status: 504, code: 'upstream_connect_timeout', cause: e });
      }
      if (abortReason.value === 'slow_response') {
        throw new GatewayError('timeout_error', 'Combo slow response threshold exceeded before first token', { status: 504, code: 'combo_slow_response_timeout', cause: e });
      }
      if (abortReason.value === 'total') {
        throw new GatewayError('timeout_error', 'Upstream total timeout', { status: 504, code: 'upstream_total_timeout', cause: e });
      }
      if (abortReason.value === 'first_token' && ttft === null) {
        throw new GatewayError('timeout_error', 'Upstream first token timeout', { status: 504, code: 'upstream_first_token_timeout', cause: e });
      }
      if (abortReason.value === 'idle' && ttft === null) {
        throw new GatewayError('timeout_error', 'Upstream first token timeout (stream idle)', { status: 504, code: 'upstream_first_token_timeout', cause: e });
      }
      throw new GatewayError('timeout_error', 'Upstream stream idle timeout', { status: 504, code: 'upstream_stream_idle_timeout', cause: e });
    }
    throw new GatewayError('upstream_unavailable', `Upstream connection failed: ${err.message}`, { status: 502, cause: e });
  } finally {
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
    readonly requestId: string | null
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
