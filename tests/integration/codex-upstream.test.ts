import { describe, expect, it, vi, afterEach } from 'vitest';
import { callCodexNonStreaming, callCodexStreaming, type CodexProviderConfig } from '../../src/server/providers/codex';

afterEach(() => vi.restoreAllMocks());
const cfg: CodexProviderConfig = { baseUrl: 'https://chatgpt.com', accountId: 'a1', accessToken: 'tok', customHeaders: {}, totalTimeoutMs: 5_000 };
const request = { model: 'gpt-5-codex', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }], stream: false };

describe('Codex upstream HTTP', () => {
  it('sends canonical requests and maps a response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'r1', model: 'gpt-5-codex', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] }), { status: 200, headers: { 'x-request-id': 'up-1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callCodexNonStreaming(cfg, request);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['chatgpt-account-id']).toBe('a1');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['openai-beta']).toBe('responses=experimental');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-5-codex', stream: false });
    expect(result.text).toBe('hello');
    expect(result.upstreamRequestId).toBe('up-1');
  });

  it('forwards response deltas as they arrive without buffering', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"a"}\n\n')); setTimeout(() => { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n')); controller.close(); }, 0); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const events: unknown[] = [];
    await callCodexStreaming(cfg, { ...request, stream: true }, (event) => events.push(event));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ text: 'a', isLast: false });
  });

  it('redacts secret-bearing non-2xx response bodies from thrown errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Bearer tok', refresh_token: 'refresh-secret' }), { status: 400 })));
    await expect(callCodexNonStreaming(cfg, request)).rejects.toThrow('Codex upstream HTTP 400');
    await expect(callCodexNonStreaming(cfg, request)).rejects.not.toThrow('refresh-secret');
  });

  it('accepts CRLF separators and dispatches an unterminated final event at EOF', async () => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"a"}\r\n\r\ndata: {"type":"response.completed"}'));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const events: unknown[] = [];
    await callCodexStreaming(cfg, { ...request, stream: true }, (event) => events.push(event));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ isLast: true });
  });
});
