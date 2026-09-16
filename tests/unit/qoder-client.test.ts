import { afterEach, describe, expect, it, vi } from 'vitest';
import { QoderModelConfigMissingError, callQoderNonStreaming, callQoderStreaming, qoderRequestPayload } from '../../src/server/providers/qoder/client';
import { parseCatalog } from '../../src/server/providers/qoder/catalog';
import type { CanonicalRequest } from '../../src/server/routing/capabilities';

afterEach(() => vi.unstubAllGlobals());

const catalog = parseCatalog({ chat: [
  { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, is_reasoning: true, max_input_tokens: 200_000, max_output_tokens: 32_768, source: 'system', context_config: [{ name: '200K', tokenCount: 200_000, isDefault: true }, { name: '1M', tokenCount: 1_000_000 }] },
] }, '2026-09-16T00:00:00.000Z');

const cfg = { accountRecordId: 'acct-1', qoderUserId: 'user-9', jobToken: 'jt-1', machineId: 'machine-1', totalTimeoutMs: 5_000, catalog };
const request: CanonicalRequest = { model: 'qoder/qmodel_38max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], stream: false, system: 'be terse', maxOutputTokens: 100 };

const envelope = (inner: unknown) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
const streamBody = (ms = 0) => new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(envelope({ id: 'c1', model: 'qmodel_38max', choices: [{ index: 0, delta: { content: 'hi' } }] })));
    setTimeout(() => {
      controller.enqueue(new TextEncoder().encode(envelope({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
      controller.enqueue(new TextEncoder().encode(envelope({ id: 'c1', choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      // The keepalive deliberately arrives AFTER the client has cancelled the socket: that is
      // the real Qoder behaviour this guard exists for. Enqueueing into a cancelled controller
      // throws ERR_INVALID_STATE, which would surface as an uncaughtException and mask the
      // assertion, so swallow it — the stream being closed is the point, not a failure.
      setTimeout(() => {
        try { controller.enqueue(new TextEncoder().encode('data: {"keepalive":true}\n\n')); } catch { /* socket already cancelled by the client */ }
      }, 50);
    }, ms);
  },
});

describe('Qoder chat client', () => {
  it('builds the payload the upstream expects, mirroring model_config', () => {
    const { payload, modelConfig } = qoderRequestPayload(request, 'qmodel_38max', catalog);
    expect(payload).toMatchObject({ stream: true, chat_task: 'FREE_INPUT', session_type: 'qodercli', agent_id: 'agent_common', system: 'be terse' });
    expect((payload.chat_context as Record<string, unknown>).text).toBe('hello');
    expect((payload.business as Record<string, unknown>).product).toBe('cli');
    expect(modelConfig.key).toBe('qmodel_38max');
    expect(payload.model_config).toBe(modelConfig);
    expect(payload.parameters).toEqual({ max_tokens: 100 });
    expect(payload.tools).toEqual([]);
  });

  it('refuses to send without the live model_config', () => {
    expect(() => qoderRequestPayload(request, 'unknown_model', catalog)).toThrow(QoderModelConfigMissingError);
  });

  it('escalates the context tier for a long prompt', () => {
    const long: CanonicalRequest = { ...request, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(900_000) }] }] };
    const { payload } = qoderRequestPayload(long, 'qmodel_38max', catalog);
    expect((payload.parameters as Record<string, unknown>).context_length).toBe(1_000_000);
    expect((payload.model_config as Record<string, unknown>).max_input_tokens).toBe(1_000_000);
  });

  it('signs the encoded body and sends it to the Qoder endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await callQoderNonStreaming(cfg, { ...request, stream: false }).catch(() => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer COSY\./);
    expect(headers['Cosy-Sigpath']).toBe('/api/v2/service/pro/sse/agent_chat_generation');
    expect(headers['Cosy-Bodylength']).toBe(String((init.body as Buffer).length));
    expect(headers['x-model-key']).toBe('qmodel_38max');
    expect(headers['accept-encoding']).toBe('identity');
    // The body on the wire is the obfuscated form, never the plaintext JSON.
    expect((init.body as Buffer).toString('latin1')).not.toContain('agent_common');
  });

  it('streams OpenAI-shaped chunks and stops at the terminal frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamBody(), { status: 200, headers: { 'x-request-id': 'up-1' } })));
    const chunks: string[] = [];
    const result = await callQoderStreaming(cfg, { ...request, stream: true }, (chunk) => chunks.push(chunk.data));
    expect(result.text).toBe('hi');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toMatchObject({ input: 7, output: 2, total: 9 });
    expect(result.upstreamRequestId).toBe('up-1');
    expect(chunks.some((c) => c.includes('"content":"hi"'))).toBe(true);
    // No chunk carries the post-[DONE] keepalive.
    expect(chunks.some((c) => c.includes('keepalive'))).toBe(false);
  });

  it('assembles the same result without streaming', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamBody(), { status: 200 })));
    const result = await callQoderNonStreaming(cfg, { ...request, stream: false });
    expect(result).toMatchObject({ status: 200, text: 'hi', finishReason: 'stop' });
    expect(result.usage.total).toBe(9);
  });

  it('reports a billing block as a typed error carrying the upstream status', async () => {
    const blocked = `data: ${JSON.stringify({ statusCodeValue: 403, body: '{"code":"112","message":"quota exhausted"}' })}\n\n`;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(blocked)); controller.close(); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    // code 112 is Qoder's billing sentinel (BILLING_CODES in sse.ts), so billing is true.
    await expect(callQoderStreaming(cfg, { ...request, stream: true }, () => {})).rejects.toMatchObject({ status: 403, billing: true });
  });

  it('redacts the token from an upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Bearer jt-1"}', { status: 500 })));
    await expect(callQoderNonStreaming(cfg, { ...request, stream: false })).rejects.toThrow('HTTP 500');
    await expect(callQoderNonStreaming(cfg, { ...request, stream: false })).rejects.not.toThrow('jt-1');
  });
});
