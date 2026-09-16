import { describe, expect, it } from 'vitest';
import { QoderEnvelopeReader } from '../../src/server/providers/qoder/sse';

const reader = () => new QoderEnvelopeReader({ model: 'qoder/qmodel_38max' });
const frame = (inner: unknown, statusCodeValue = 200) => `data: ${JSON.stringify({ statusCodeValue, body: JSON.stringify(inner) })}\n\n`;

describe('Qoder SSE envelope reader', () => {
  it('unwraps envelope frames into OpenAI-shaped chunks', () => {
    const r = reader();
    r.push(frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'he' } }] }));
    r.push(frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'llo' } }] }));
    expect(r.chunks.map((c) => JSON.parse(c) as { choices: Array<{ delta: { content?: string } }> }))
      .toEqual([
        expect.objectContaining({ choices: [expect.objectContaining({ delta: { content: 'he' } })] }),
        expect.objectContaining({ choices: [expect.objectContaining({ delta: { content: 'llo' } })] }),
      ]);
    expect(r.text).toBe('hello');
    expect(r.terminal()).toBe(false);
  });

  it('coalesces a delta finish_reason with the later usage frame into one terminal chunk', () => {
    const r = reader();
    r.push(frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'done', finish_reason: 'stop' } }] }));
    expect(r.terminal()).toBe(false); // usage has not arrived yet — do not end the stream
    r.push(frame({ id: 'c1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } } }));
    expect(r.terminal()).toBe(true);
    const last = JSON.parse(r.chunks.at(-1)!) as { choices: Array<{ finish_reason: string }>; usage: { prompt_tokens: number } };
    expect(last.choices[0]!.finish_reason).toBe('stop');
    expect(last.usage.prompt_tokens).toBe(11);
    expect(r.usage).toMatchObject({ input: 11, output: 4, total: 15, cacheRead: 3, cacheWrite: 0, reasoning: 0 });
    expect(r.finishReason).toBe('stop');
  });

  it('collects streamed tool calls into the canonical result', () => {
    const r = reader();
    r.push(frame({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] }));
    expect(r.toolCalls).toEqual([{ id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }]);
  });

  it('surfaces a non-200 envelope as an error instead of text', () => {
    const r = reader();
    r.push(frame('{"code":"112","message":"quota exhausted"}', 403));
    expect(r.errorEnvelope()).toEqual({ statusValue: 403, message: '{"code":"112","message":"quota exhausted"}', billing: true });
    expect(r.terminal()).toBe(true);
  });

  it('treats a pricing wall as a billing block', () => {
    const r = reader();
    r.push(frame('{"pricingUrl":"https://qoder.com/pricing"}', 403));
    expect(r.errorEnvelope()?.billing).toBe(true);
  });

  it('flushes a trailing frame that arrives without a terminating blank line', () => {
    const r = reader();
    r.push(`data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ index: 0, delta: { content: 'tail' } }] }) })}`);
    r.finish();
    expect(r.text).toBe('tail');
  });

  it('stops accepting frames once terminal', () => {
    const r = reader();
    r.push(frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const before = r.chunks.length;
    r.push(frame({ choices: [{ index: 0, delta: { content: 'late' } }] }));
    expect(r.chunks).toHaveLength(before);
    expect(r.text).toBe('');
  });

  it('stops accepting frames once terminal even when a chunk ends on a single newline', () => {
    // The test above passes even without an `ended` guard in push(), because frame()'s
    // trailing blank line leaves a newline in the buffer that returns early. Split the
    // stream right after one newline — as real TCP framing does — to pin the guard.
    const r = reader();
    r.push(`data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) })}\n`);
    expect(r.terminal()).toBe(true);
    const before = r.chunks.length;
    r.push(frame({ choices: [{ index: 0, delta: { content: 'late' } }] }));
    expect(r.chunks).toHaveLength(before);
    expect(r.text).toBe('');
  });

  it('handles an envelope body that is already an object', () => {
    const r = reader();
    r.push(`data: ${JSON.stringify({ statusCodeValue: 200, body: { choices: [{ index: 0, delta: { content: 'obj' } }] } })}\n\n`);
    expect(r.text).toBe('obj');
  });

  it('ends on usage-only termination when a delta frame carries usage without a finish_reason', () => {
    // Regression: the delta path used to require BOTH pendingFinish and pendingUsage, so this
    // shape left the stream open forever. Assert without finish() — calling finish() first
    // would flushPending() and make the broken code pass.
    const r = reader();
    r.push(frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    expect(r.terminal()).toBe(true);
    const last = JSON.parse(r.chunks.at(-1)!) as { choices: Array<{ finish_reason: string; delta: object }>; usage: { prompt_tokens: number } };
    expect(last.choices[0]!.finish_reason).toBe('stop');
    expect(last.choices[0]!.delta).toEqual({});
    expect(last.usage.prompt_tokens).toBe(3);
    expect(r.text).toBe('hi');
    expect(r.finishReason).toBe('stop'); // accessor reports the value we actually emitted
  });

  it('does not overwrite a real upstream finish_reason in the accessor', () => {
    const r = reader();
    r.push(frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'x', finish_reason: 'length' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    expect(r.terminal()).toBe(true);
    expect(r.finishReason).toBe('length');
  });

  it('preserves a non-stop finish reason across the coalesce', () => {
    const r = reader();
    r.push(frame({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }], finish_reason: 'tool_calls' } }] }));
    r.push(frame({ id: 'c1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    const last = JSON.parse(r.chunks.at(-1)!) as { choices: Array<{ finish_reason: string }> };
    expect(last.choices[0]!.finish_reason).toBe('tool_calls');
    expect(r.finishReason).toBe('tool_calls');
  });
});
