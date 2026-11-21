// Unit tests: the streaming watchdog names the limit that actually fired.
// Regression: the total timeout used to surface as "Upstream stream idle timeout".
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { callUpstreamNonStreaming, callUpstreamStreaming, type UpstreamConfig } from '../../src/server/upstream/client';
import { GatewayError } from '../../src/server/errors';

let server: http.Server | null = null;

/** SSE endpoint: writes `chunks` frames 20ms apart, then holds the socket open forever. */
async function hangingStream(chunks: number): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders(); // headers must land even when no frame is ever written
    let sent = 0;
    if (chunks === 0) return;
    const timer = setInterval(() => {
      sent += 1;
      res.write(`data: ${JSON.stringify({ delta: sent })}\n\n`);
      if (sent === chunks) clearInterval(timer);
    }, 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

async function silentServer(sendHeaders: boolean): Promise<string> {
  server = http.createServer((_req, res) => {
    if (sendHeaders) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

async function stalledErrorBody(status: number): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.flushHeaders();
    // Deliberately leave the error body open; the provider total deadline must
    // bound the read without replacing the already-known HTTP status.
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

async function metadataThenHang(): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.write('data: {"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":1}}\n\n');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

async function delayedHeadersThenHang(delayMs: number): Promise<string> {
  server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    }, delayMs);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

const cfg = (overrides: Partial<UpstreamConfig>): UpstreamConfig => ({
  type: 'openai', baseUrl: 'http://127.0.0.1', apiKey: 'k', customHeaders: {},
  connectTimeoutMs: 5000, firstTokenTimeoutMs: 5000, streamIdleTimeoutMs: 5000, totalTimeoutMs: 5000,
  ...overrides,
});

const reasonOf = async (url: string, config: UpstreamConfig, onChunk: () => boolean = () => true): Promise<string> => {
  try {
    await callUpstreamStreaming(config, url, { model: 'm', stream: true }, onChunk);
    throw new Error('stream unexpectedly completed');
  } catch (e) {
    return (e as Error).message;
  }
};

afterEach(() => { server?.closeAllConnections(); server?.close(); server = null; });

describe('callUpstreamStreaming watchdogs', () => {
  it('reports the total timeout when the whole request exceeds it', async () => {
    const url = await hangingStream(1);
    await expect(reasonOf(url, cfg({ totalTimeoutMs: 300, streamIdleTimeoutMs: 5000 }))).resolves.toBe('Upstream total timeout');
  });

  it('reports the idle timeout when frames stop after the first token', async () => {
    const url = await hangingStream(1);
    await expect(reasonOf(url, cfg({ totalTimeoutMs: 5000, streamIdleTimeoutMs: 300 }))).resolves.toBe('Upstream stream idle timeout');
  });

  it('reports the first-token timeout when no frame ever arrives', async () => {
    const url = await hangingStream(0);
    await expect(reasonOf(url, cfg({ totalTimeoutMs: 5000, streamIdleTimeoutMs: 5000, firstTokenTimeoutMs: 300 }))).resolves.toBe('Upstream first token timeout');
  });

  it('starts the provider first-token timeout after response headers', async () => {
    const url = await delayedHeadersThenHang(400);
    const start = Date.now();
    await expect(reasonOf(url, cfg({ connectTimeoutMs: 2000, totalTimeoutMs: 5000, streamIdleTimeoutMs: 2000, firstTokenTimeoutMs: 300 })))
      .resolves.toBe('Upstream first token timeout');
    expect(Date.now() - start).toBeGreaterThanOrEqual(650);
  });

  it('keeps the first-token watchdog armed after metadata-only SSE events', async () => {
    const url = await metadataThenHang();
    await expect(reasonOf(url, cfg({ totalTimeoutMs: 5000, streamIdleTimeoutMs: 2000, firstTokenTimeoutMs: 300 }), () => false))
      .resolves.toBe('Upstream first token timeout');
  });

  it('classifies a combo TTFT threshold after metadata-only events as a slow response', async () => {
    const url = await metadataThenHang();
    await expect(callUpstreamStreaming(
      cfg({ totalTimeoutMs: 5000, streamIdleTimeoutMs: 2000, firstTokenTimeoutMs: 5000, slowResponseTimeoutMs: 300 }),
      url,
      { model: 'm', stream: true },
      () => false,
    )).rejects.toMatchObject({ code: 'combo_slow_response_timeout' });
  });

  it('measures combo TTFT from request start, including time spent waiting for response headers', async () => {
    const url = await delayedHeadersThenHang(400);
    await expect(callUpstreamStreaming(
      cfg({ connectTimeoutMs: 2000, totalTimeoutMs: 5000, firstTokenTimeoutMs: 5000, slowResponseTimeoutMs: 300 }),
      url,
      { model: 'm', stream: true },
      () => false,
    )).rejects.toMatchObject({ code: 'combo_slow_response_timeout' });
  });

  it('aborts a non-streaming response body that exceeds the combo slow-response threshold', async () => {
    const url = await silentServer(true);
    await expect(callUpstreamNonStreaming(
      cfg({ totalTimeoutMs: 5000, connectTimeoutMs: 2000, slowResponseTimeoutMs: 300 }),
      url,
      { model: 'm', stream: false },
    )).rejects.toMatchObject({ code: 'combo_slow_response_timeout' });
  });

  it('preserves a known non-2xx status when its non-streaming error body reaches total timeout', async () => {
    const url = await stalledErrorBody(408);
    const startedAt = Date.now();
    await expect(callUpstreamNonStreaming(
      cfg({ connectTimeoutMs: 2000, totalTimeoutMs: 650, slowResponseTimeoutMs: 250 }),
      url,
      { model: 'm', stream: false },
    )).rejects.toMatchObject({ code: 'upstream_http_408', cause: { status: 408 } });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
  });

  it('preserves a known non-2xx status when its streaming error body reaches total timeout', async () => {
    const url = await stalledErrorBody(408);
    const startedAt = Date.now();
    await expect(callUpstreamStreaming(
      cfg({ connectTimeoutMs: 2000, totalTimeoutMs: 650, slowResponseTimeoutMs: 250 }),
      url,
      { model: 'm', stream: true },
      () => false,
    )).rejects.toMatchObject({ code: 'upstream_http_408', cause: { status: 408 } });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
  });

  it('aborts the upstream stream when the downstream chunk callback rejects a pre-content event', async () => {
    let clientClosed = false;
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"choices":[{"index":0,"delta":{}}]}\n\n');
      res.on('close', () => { clientClosed = true; });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;

    await expect(callUpstreamStreaming(cfg({ totalTimeoutMs: 5000 }), url, { model: 'm', stream: true }, () => {
      throw new GatewayError('timeout_error', 'Combo slow response threshold exceeded', { status: 504, code: 'combo_slow_response_timeout' });
    })).rejects.toMatchObject({ code: 'combo_slow_response_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clientClosed).toBe(true);
  });

  it('cancels the upstream reader when the downstream cancellation signal fires', async () => {
    let upstreamClosed = false;
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"choices":[{"index":0,"delta":{"content":"first token"}}]}\n\n');
      res.on('close', () => { upstreamClosed = true; });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const downstream = new AbortController();
    const pending = callUpstreamStreaming(
      cfg({ totalTimeoutMs: 5000 }),
      url,
      { model: 'm', stream: true },
      () => true,
      'test-disconnect',
      Date.now(),
      downstream.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    downstream.abort();
    await expect(pending).rejects.toMatchObject({ code: 'client_disconnected', status: 499 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upstreamClosed).toBe(true);
  });

  it('aborts a streaming connection when response headers exceed connect timeout', async () => {
    const url = await silentServer(false);
    await expect(callUpstreamStreaming(cfg({ connectTimeoutMs: 300, firstTokenTimeoutMs: 3000 }), url, { model: 'm', stream: true }, () => false))
      .rejects.toMatchObject({ code: 'upstream_connect_timeout', message: 'Upstream connect timeout' });
  });

  it('aborts a non-streaming connection when response headers exceed connect timeout', async () => {
    const url = await silentServer(false);
    await expect(callUpstreamNonStreaming(cfg({ connectTimeoutMs: 300 }), url, { model: 'm', stream: false }))
      .rejects.toMatchObject({ code: 'upstream_connect_timeout', message: 'Upstream connect timeout' });
  });
});
