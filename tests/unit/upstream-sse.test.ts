import { afterEach, describe, expect, it, vi } from 'vitest';
import { callUpstreamStreaming, type UpstreamConfig } from '../../src/server/upstream/client';
import { GatewayError } from '../../src/server/errors';

const cfg: UpstreamConfig = {
  type: 'openai', baseUrl: 'https://example.invalid', apiKey: 'k', customHeaders: {},
  connectTimeoutMs: 5000, firstTokenTimeoutMs: 5000, streamIdleTimeoutMs: 5000, totalTimeoutMs: 5000,
};
const url = `${cfg.baseUrl}/v1/chat/completions`;
const encoder = new TextEncoder();
type Chunk = { data: string; event?: string };

function mockResponse(chunks: Uint8Array[], options: { contentType?: string; linger?: boolean; status?: number } = {}) {
  // A deliberately unresolved cancellation exercises the terminal fast path:
  // completion cannot depend on the upstream underlying source acknowledging it.
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else if (!options.linger) controller.close();
    },
    cancel,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
    status: options.status ?? 200,
    headers: { 'content-type': options.contentType ?? 'text/event-stream', 'x-request-id': 'upstream-sse-test' },
  })));
  return cancel;
}

const stream = (onChunk: (chunk: Chunk, first: boolean) => boolean | void, config = cfg) =>
  callUpstreamStreaming(config, url, { model: 'm', stream: true }, onChunk);

afterEach(() => vi.unstubAllGlobals());

describe('upstream SSE framing and completion', () => {
  it('preserves split UTF-8, multiline data and mixed CR/LF framing across every byte', async () => {
    const data = '{"content": "Tiếng Việt 🌍",\n"other": "  spaces  "}';
    const body = `\uFEFF: comment\r\n\r\nevent: delta\rdata: ${data.replace('\n', '\r\ndata: ')}\n\r\ndata:  x  \r\rdata:\n\ndata: [DONE]\n\n`;
    mockResponse(Array.from(encoder.encode(body), (byte) => Uint8Array.of(byte)));
    const received: Array<{ chunk: Chunk; first: boolean }> = [];
    const result = await stream((chunk, first) => { received.push({ chunk, first }); return true; });
    expect(received).toEqual([
      { chunk: { data, event: 'delta' }, first: true },
      { chunk: { data: ' x  ', event: 'message' }, first: false },
    ]);
    expect(result).toMatchObject({ terminalSeen: true, upstreamStatus: 200, contentType: 'text/event-stream', upstreamRequestId: 'upstream-sse-test' });
    expect(result.ttftMs).not.toBeNull();
  });

  it('accepts a complete frame at clean EOF without inventing a terminal marker or cancelling', async () => {
    const cancel = mockResponse([encoder.encode('data: {"finish_reason":"stop"}\n\n')]);
    const onChunk = vi.fn(() => false);
    const result = await stream(onChunk);
    expect(result).toMatchObject({ terminalSeen: false, ttftMs: null });
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(['data: {"x":1}', 'data: {"x":1}\n', 'data: {"x":1}\r\n'])('rejects an undispatched partial frame at EOF: %j', async (body) => {
    mockResponse([encoder.encode(body)]);
    const onChunk = vi.fn();
    await expect(stream(onChunk)).rejects.toMatchObject({
      code: 'upstream_bad_response', cause: { stage: 'truncated_stream', upstreamStatus: 200, upstreamRequestId: 'upstream-sse-test' },
    });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('bounds unframed data by UTF-8 bytes before dispatching', async () => {
    mockResponse([encoder.encode(`data: ${'🌍'.repeat(270_000)}`)], { linger: true });
    const onChunk = vi.fn();
    await expect(stream(onChunk)).rejects.toMatchObject({
      code: 'upstream_bad_response', cause: { stage: 'sse_frame_limit', upstreamStatus: 200 },
    });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('bounds the entire multiline frame, not only individual lines', async () => {
    const line = encoder.encode(`data: ${'x'.repeat(600_000)}\n`);
    mockResponse([line, line], { linger: true });
    await expect(stream(() => false)).rejects.toMatchObject({ code: 'upstream_bad_response', cause: { stage: 'sse_frame_limit' } });
  });

  it('rejects incomplete UTF-8 at EOF rather than replacing bytes in a generation', async () => {
    mockResponse([encoder.encode('data: {"content":"'), Uint8Array.of(0xf0, 0x9f)]);
    await expect(stream(() => false)).rejects.toMatchObject({ code: 'upstream_bad_response', cause: { stage: 'invalid_sse_utf8' } });
  });

  it('delivers a bounded OpenAI JSON completion as one snapshot after EOF', async () => {
    const data = '{"choices":[{"message":{"content":"answer"},"finish_reason":"stop"}]}';
    const cancel = mockResponse([encoder.encode(data.slice(0, 20)), encoder.encode(data.slice(20))], { contentType: 'application/json' });
    const onChunk = vi.fn(() => true);
    const result = await stream(onChunk);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith({ event: 'json', data }, true);
    expect(result).toMatchObject({ terminalSeen: true, contentType: 'application/json', upstreamStatus: 200 });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('rejects oversized JSON before emitting any snapshot', async () => {
    mockResponse([encoder.encode('x'.repeat(1024 * 1024 + 1))], { contentType: 'application/json', linger: true });
    const onChunk = vi.fn();
    await expect(stream(onChunk)).rejects.toMatchObject({ code: 'upstream_bad_response', cause: { stage: 'json_body_limit' } });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('rejects non-SSE content types that cannot be normalized, with HTTP status and request ID', async () => {
    const cancel = mockResponse([encoder.encode('<html>wrong response</html>')], { contentType: 'text/html', linger: true });
    const onChunk = vi.fn();
    await expect(stream(onChunk)).rejects.toMatchObject({ code: 'upstream_bad_response', status: 502,
      cause: { stage: 'unexpected_content_type', contentType: 'text/html', status: 200, upstreamStatus: 200, upstreamRequestId: 'upstream-sse-test' },
    });
    expect(onChunk).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a 2xx SSE response with no body as a bad response, not an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'empty-body' },
    })));
    await expect(stream(() => false)).rejects.toMatchObject({ code: 'upstream_bad_response', status: 502,
      cause: { stage: 'missing_body', upstreamStatus: 204, upstreamRequestId: 'empty-body' },
    });
  });

  it('reads finish and usage before DONE, ignores trailing events and does not wait for cancellation', async () => {
    const cancel = mockResponse([encoder.encode('data: {"finish_reason":"stop"}\n\ndata: {"usage":{"completion_tokens":1}}\n\ndata: [DONE]\n\ndata: ignored\n\n')], { linger: true, contentType: 'Text/Event-Stream; charset=utf-8' });
    const seen: string[] = [];
    const result = await stream((chunk) => { seen.push(chunk.data); return false; });
    expect(result).toMatchObject({ terminalSeen: true, ttftMs: null });
    expect(seen).toEqual(['{"finish_reason":"stop"}', '{"usage":{"completion_tokens":1}}']);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('dispatches Anthropic message_stop once and stops (named event=%s)', async (named) => {
    const cancel = mockResponse([encoder.encode(`data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n${named ? 'event: message_stop\n' : ''}data: {"type":"message_stop"}\n\ndata: ignored\n\n`)], { linger: true });
    const received: Chunk[] = [];
    const result = await stream((chunk) => { received.push(chunk); return false; }, { ...cfg, type: 'anthropic' });
    expect(result.terminalSeen).toBe(true);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ event: named ? 'message_stop' : 'message', data: '{"type":"message_stop"}' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves a callback GatewayError and its details with response metadata', async () => {
    const cancel = mockResponse([encoder.encode('data: {}\n\n')], { linger: true });
    await expect(stream(() => { throw new GatewayError('upstream_error', 'Rejected chunk', {
      code: 'upstream_bad_response', cause: { stage: 'unsupported_shape', usage: { input: 1 } },
    }); })).rejects.toMatchObject({ code: 'upstream_bad_response', message: 'Rejected chunk',
      cause: { stage: 'unsupported_shape', usage: { input: 1 }, upstreamStatus: 200, upstreamRequestId: 'upstream-sse-test', contentType: 'text/event-stream' },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
