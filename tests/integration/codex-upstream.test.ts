import { describe, expect, it, vi, afterEach } from 'vitest';
import { callCodexNonStreaming, callCodexStreaming, type CodexProviderConfig } from '../../src/server/providers/codex';

// restoreAllMocks does not un-stub stubGlobal; a leaked fetch stub breaks later integration files.
afterEach(() => vi.unstubAllGlobals());
const cfg: CodexProviderConfig = { baseUrl: 'https://chatgpt.com', accountId: 'a1', accessToken: 'tok', customHeaders: {}, totalTimeoutMs: 5_000 };
const request = { model: 'gpt-5-codex', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }], stream: false };

describe('Codex upstream HTTP', () => {
  /**
   * Regression: every follow-up turn in a conversation answered `502 Codex upstream HTTP 400`,
   * while the first message worked. The backend rejects `input_text` on an assistant turn
   * ("Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'") — verified
   * live against chatgpt.com. A plain chat request carries the previous answer in its history,
   * so this hit every second message.
   */
  it('sends an assistant turn as output_text, and user turns as input_text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: [], usage: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await callCodexNonStreaming(cfg, {
      model: 'gpt-5.6-terra',
      stream: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help you today?' }] },
        { role: 'user', content: [{ type: 'text', text: 'bạn là model gì' }] },
      ],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Hello! How can I help you today?' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'bạn là model gì' }] },
    ]);
    expect(JSON.stringify(body.input)).not.toContain('"input_text","text":"Hello!');
  });

  /**
   * Tool calls are top-level items upstream, never content blocks: a `function_call` inside
   * `content` is rejected with "Supported values are: 'input_text', 'input_image', …".
   */
  it('sends tool calls and results as flat function_call / function_call_output items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: [], usage: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await callCodexNonStreaming(cfg, {
      model: 'gpt-5.6-terra',
      stream: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather in Hanoi?' }] },
        { role: 'assistant', content: [{ type: 'tool_use', toolUse: { id: 'call_1', name: 'get_weather', input: { city: 'Hanoi' } } }] },
        { role: 'tool', content: [{ type: 'tool_result', toolResult: { toolUseId: 'call_1', content: '{"tempC":31}' } }] },
      ],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'weather in Hanoi?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Hanoi"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"tempC":31}' },
    ]);
  });

  it('always sends store:false + stream:true, and merges a non-streaming caller from the stream', async () => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3}}}\n\n'));
      controller.close();
    } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { 'x-request-id': 'up-1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callCodexNonStreaming(cfg, request);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['chatgpt-account-id']).toBe('a1');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['openai-beta']).toBe('responses=experimental');
    // The Codex backend 400s unless both flags are exactly this; a request asking
    // for stream:false still goes upstream streaming and is merged here.
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-5-codex', stream: true, store: false });
    expect(result.text).toBe('hello');
    expect(result.usage).toMatchObject({ input: 2, output: 3, total: 5 });
    expect(result.upstreamRequestId).toBe('up-1');
  });

  it('merges tool calls from output_item.done, since response.completed carries an empty output', async () => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"Hanoi\\"}"}}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const result = await callCodexNonStreaming(cfg, request);
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', input: { city: 'Hanoi' } }]);
    expect(result.finishReason).toBe('completed');
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

  it('includes the upstream explanation in the thrown error', async () => {
    // Without this the operator only sees "HTTP 400" and has to re-derive the cause by hand.
    // mockImplementation, not mockResolvedValue: a Response body is single-use and a real fetch returns a fresh one.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      error: { message: "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.", type: 'invalid_request_error', param: 'input[1].content[0]', code: 'invalid_value' },
    }), { status: 400 }))));
    const error = await callCodexNonStreaming(cfg, request).catch((e: Error) => e);
    expect((error as Error).message).toContain("Invalid value: 'input_text'");
    expect((error as Error).message).toContain('param input[1].content[0]');
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
