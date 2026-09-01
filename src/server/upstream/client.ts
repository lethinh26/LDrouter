// Upstream HTTP client: streaming + non-streaming with timeouts and error normalization.

import type { Provider } from '../db/schema';
import { decryptSecret, decryptCustomHeaders } from '../auth/crypto';
import { GatewayError } from '../errors';
import { buildHeaders, stripSlash } from '../providers/index';

export interface UpstreamConfig {
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  customHeaders: Record<string, string>;
  connectTimeoutMs: number;
  firstTokenTimeoutMs: number;
  streamIdleTimeoutMs: number;
  totalTimeoutMs: number;
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

export async function callUpstreamNonStreaming(cfg: UpstreamConfig, url: string, payload: unknown): Promise<UpstreamCall> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.totalTimeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders(cfg), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text();
    const ttft = Date.now() - start;
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
    if (err.name === 'AbortError') {
      throw new GatewayError('timeout_error', 'Upstream request timed out', { status: 504, cause: e });
    }
    throw new GatewayError('upstream_unavailable', `Upstream connection failed: ${err.message}`, { status: 502, cause: e });
  } finally {
    clearTimeout(timer);
  }
}

export function extractUpstreamRequestId(headers: Headers | Record<string, string>): string | null {
  if (headers instanceof Headers) {
    return headers.get('x-request-id') ?? headers.get('request-id') ?? headers.get('x-amzn-requestid') ?? null;
  }
  return headers['x-request-id'] ?? headers['request-id'] ?? headers['x-amzn-requestid'] ?? null;
}

/**
 * Call upstream with SSE streaming. Invokes onChunk for each SSE event.
 * Returns a promise resolving when the stream completes or rejects on failure.
 */
export async function callUpstreamStreaming(
  cfg: UpstreamConfig,
  url: string,
  payload: unknown,
  onChunk: (event: { data: string; event?: string }, isFirst: boolean) => void
): Promise<{ headers: Record<string, string>; upstreamRequestId: string | null; ttftMs: number }> {
  const ctl = new AbortController();
  const totalTimer = setTimeout(() => ctl.abort(), cfg.totalTimeoutMs);
  const start = Date.now();
  let ttft: number | null = null;
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctl.abort(), cfg.streamIdleTimeoutMs);
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders(cfg), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new UpstreamHttpError(res.status, text, extractUpstreamRequestId(res.headers));
    }
    // First-token watchdog
    firstTokenTimer = setTimeout(() => ctl.abort(), cfg.firstTokenTimeoutMs);
    resetIdle();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isFirst = true;
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete SSE events (split on blank line)
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = rawEvent.split('\n');
        let data = '';
        let event = 'message';
        for (const line of lines) {
          if (line.startsWith('data:')) data = line.slice(5).trimStart();
          else if (line.startsWith('event:')) event = line.slice(6).trimStart();
        }
        if (data === '[DONE]') {
          done = true;
          break;
        }
        if (data) {
          if (ttft === null) {
            ttft = Date.now() - start;
            if (firstTokenTimer) clearTimeout(firstTokenTimer);
          }
          resetIdle();
          onChunk({ data, event }, isFirst);
          isFirst = false;
        }
      }
    }
    return {
      headers: Object.fromEntries(res.headers.entries()),
      upstreamRequestId: extractUpstreamRequestId(res.headers),
      ttftMs: ttft ?? Date.now() - start,
    };
  } catch (e) {
    if (e instanceof UpstreamHttpError) {
      if (e.status >= 500) throw new GatewayError('upstream_error', `Upstream HTTP ${e.status}`, { status: 502, cause: e, code: 'upstream_http_' + e.status });
      if (e.status === 429) throw new GatewayError('upstream_rate_limit', 'Upstream rate limited', { status: 529, cause: e });
      if (e.status === 401 || e.status === 403) throw new GatewayError('upstream_auth_error', 'Upstream authentication failed', { status: 502, cause: e });
      throw new GatewayError('upstream_error', `Upstream HTTP ${e.status}: ${e.bodyExcerpt}`, { status: 502, cause: e });
    }
    const err = e as Error;
    if (err.name === 'AbortError') {
      if (ttft === null && firstTokenTimer) {
        throw new GatewayError('timeout_error', 'Upstream first token timeout', { status: 504, cause: e });
      }
      throw new GatewayError('timeout_error', 'Upstream stream idle timeout', { status: 504, cause: e });
    }
    throw new GatewayError('upstream_unavailable', `Upstream connection failed: ${err.message}`, { status: 502, cause: e });
  } finally {
    clearTimeout(totalTimer);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    if (idleTimer) clearTimeout(idleTimer);
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
