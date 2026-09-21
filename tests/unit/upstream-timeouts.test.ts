// Unit tests: the streaming watchdog names the limit that actually fired.
// Regression: the total timeout used to surface as "Upstream stream idle timeout".
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { callUpstreamStreaming, type UpstreamConfig } from '../../src/server/upstream/client';

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

const cfg = (overrides: Partial<UpstreamConfig>): UpstreamConfig => ({
  type: 'openai', baseUrl: 'http://127.0.0.1', apiKey: 'k', customHeaders: {},
  connectTimeoutMs: 5000, firstTokenTimeoutMs: 5000, streamIdleTimeoutMs: 5000, totalTimeoutMs: 5000,
  ...overrides,
});

const reasonOf = async (url: string, config: UpstreamConfig): Promise<string> => {
  try {
    await callUpstreamStreaming(config, url, { model: 'm', stream: true }, () => {});
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
});
