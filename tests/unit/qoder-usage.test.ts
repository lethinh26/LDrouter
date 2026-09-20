// Qoder usage: every Qoder request used to log `in 0 · out 0 · cache 0`.
//
// Two independent causes, both covered here:
//  1. Streaming. The Qoder branch pipes OpenAI-shaped chunks through the runner's
//     shared chunk handler, but that handler only parsed usage under
//     `cfg.type === 'openai'` — so the accumulator stayed all zeros and the
//     request was persisted with no tokens (verified live: 128/128 streaming
//     Qoder requests carried zero).
//  2. The non-compliant envelope. Qoder wraps the real OpenAI object one level
//     down as `{statusCodeValue, body: "<json>"}`, so a usage block is seen as
//     `usage.usage.*` by the flat reader.
import { describe, expect, it } from 'vitest';
import { QoderEnvelopeReader, qoderUsageOf } from '../../src/server/providers/qoder/sse';
import { callQoderStreaming, callQoderNonStreaming } from '../../src/server/providers/qoder/client';
import type { QoderProviderConfig } from '../../src/server/providers/qoder/client';

describe('qoderUsageOf reads the nested envelope shape', () => {
  it('reads a usage object nested under `usage`', () => {
    const u = qoderUsageOf({ usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 5 } } });
    expect(u).toMatchObject({ input: 11, output: 7, total: 18, cacheRead: 5 });
  });

  it('still reads the flat shape', () => {
    const u = qoderUsageOf({ prompt_tokens: 4, completion_tokens: 2, cached_tokens: 1 });
    expect(u).toMatchObject({ input: 4, output: 2, total: 6, cacheRead: 1 });
  });

  it('never invents counts for a missing usage block', () => {
    expect(qoderUsageOf({})).toMatchObject({ input: 0, output: 0, total: 0, cacheRead: 0 });
    expect(qoderUsageOf(undefined)).toMatchObject({ input: 0, output: 0, total: 0 });
  });
});

const CATALOG = {
  fetchedAt: '2026-09-16T00:00:00.000Z',
  entries: new Map([['qmodel_38max', {
    key: 'qmodel_38max', displayName: 'Qwen3.8-Max', enabled: true, isReasoning: false, isVl: false,
    maxInputTokens: 200_000, maxOutputTokens: 32_768, isFree: false,
    raw: { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, source: 'system' },
  }]]),
} as unknown as QoderProviderConfig['catalog'];

const config = (): QoderProviderConfig => ({
  accountRecordId: 'acct-1', qoderUserId: 'user-1', jobToken: 'jt', machineId: 'm1',
  name: 'acct', email: 'a@example.com', totalTimeoutMs: 5000, catalog: CATALOG,
});

const request = () => ({ model: 'qmodel_38max', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], stream: false });

const envelope = (inner: unknown) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;

/** A Response whose body is the given SSE text. */
const sseResponse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('Qoder streaming reports the usage it received', () => {
  it('surfaces usage from the terminal frame, with the cache split preserved', async () => {
    const body = [
      envelope({ id: 'c1', choices: [{ index: 0, delta: { content: 'hello' } }] }),
      envelope({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      envelope({ id: 'c1', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 90 } } }),
      'data: [DONE]\n\n',
    ].join('');
    const chunks: Array<{ data: string }> = [];
    const out = await callQoderStreaming(config(), request(), (c) => chunks.push(c), { fetchImpl: (() => Promise.resolve(sseResponse(body))) as unknown as typeof fetch });

    expect(out.usage).toMatchObject({ input: 120, output: 30, total: 150, cacheRead: 90 });
    expect(out.text).toBe('hello');
    expect(out.finishReason).toBe('stop');
    // The terminal chunk carries the usage downstream, which is what the client reads.
    expect(chunks.some((c) => c.data.includes('"prompt_tokens":120'))).toBe(true);
  });
});

describe('a non-streaming Qoder call that answers with a plain body still reports usage', () => {
  it('parses a whole OpenAI completion delivered without SSE framing', async () => {
    const payload = JSON.stringify({
      id: 'c9', object: 'chat.completion', model: 'qmodel_38max',
      choices: [{ index: 0, message: { role: 'assistant', content: 'plain answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50, prompt_tokens_details: { cached_tokens: 12 } },
    });
    const out = await callQoderNonStreaming(config(), request(), { fetchImpl: (() => Promise.resolve(new Response(payload, { status: 200 }))) as unknown as typeof fetch });

    expect(out.usage).toMatchObject({ input: 42, output: 8, total: 50, cacheRead: 12 });
    expect(out.text).toBe('plain answer');
    expect(out.finishReason).toBe('stop');
  });

  it('does not misfire when the answer IS framed as SSE', async () => {
    const body = [
      envelope({ id: 'c1', choices: [{ index: 0, delta: { content: 'framed' } }] }),
      envelope({ id: 'c1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
      'data: [DONE]\n\n',
    ].join('');
    const out = await callQoderNonStreaming(config(), request(), { fetchImpl: (() => Promise.resolve(sseResponse(body))) as unknown as typeof fetch });
    expect(out.text).toBe('framed');
    expect(out.usage).toMatchObject({ input: 3, output: 1, total: 4 });
  });
});

describe('reader hardening', () => {
  it('never reports a fabricated zero usage when the origin sent none', () => {
    const reader = new QoderEnvelopeReader({ model: 'qoder/qmodel_38max' });
    reader.push(envelope({ id: 'c1', choices: [{ index: 0, delta: { content: 'x' } }] }));
    reader.finish();
    expect(reader.usage).toBeNull();
  });

  it('keeps text, tool calls and finish reason from a plain completion', () => {
    const reader = new QoderEnvelopeReader({ model: 'qoder/qmodel_38max' });
    reader.push(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'yo', tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
    reader.applyCompletion(JSON.parse(reader.takeUnparsed()) as Record<string, unknown>);
    expect(reader.text).toBe('yo');
    expect(reader.toolCalls).toEqual([{ id: 't1', name: 'f', input: { a: 1 } }]);
    expect(reader.finishReason).toBe('tool_calls');
    expect(reader.usage).toMatchObject({ input: 1, output: 2, total: 3 });
  });
});

