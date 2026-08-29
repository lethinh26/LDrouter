// Unit tests: canonical protocol conversions.
import { describe, expect, it } from 'vitest';
import { openAIToCanonical, canonicalToOpenAIRequest, openAIResponseToCanonical } from '../../src/server/protocols/canonical';
import { anthropicToCanonical, canonicalToAnthropicRequest, anthropicResponseToCanonical } from '../../src/server/protocols/anthropic';

describe('OpenAI <-> canonical', () => {
  it('parses system + user + assistant + tool messages', () => {
    const out = openAIToCanonical({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' } }] },
        { role: 'tool', content: '{"temp":30}', tool_call_id: 'call1' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    expect(out.system).toBe('be nice');
    expect(out.messages.length).toBe(3);
    expect(out.messages[1]!.content[0]!.type).toBe('tool_use');
    expect(out.messages[2]!.content[0]!.type).toBe('tool_result');
    expect(out.tools![0]!.name).toBe('get_weather');
  });

  it('round-trips a basic chat request to OpenAI', () => {
    const canonical = {
      model: 'gpt',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      stream: false,
    };
    const out = canonicalToOpenAIRequest(canonical, 'gpt-4o-mini');
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('parses usage into normalized fields', () => {
    const r = openAIResponseToCanonical({
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 5 } },
    } as never, 'gpt');
    expect(r.text).toBe('hello');
    expect(r.usage.input).toBe(12);
    expect(r.usage.output).toBe(8);
    expect(r.usage.cacheRead).toBe(5);
    expect(r.usage.total).toBe(20);
    expect(r.finishReason).toBe('stop');
  });
});

describe('Anthropic <-> canonical', () => {
  it('parses simple messages', () => {
    const out = anthropicToCanonical({
      model: 'claude',
      system: 'be safe',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 256,
    });
    expect(out.system).toBe('be safe');
    expect(out.messages[0]!.content[0]!.text).toBe('hello');
    expect(out.maxOutputTokens).toBe(256);
  });

  it('parses image blocks', () => {
    const out = anthropicToCanonical({
      model: 'claude',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] }],
      max_tokens: 256,
    });
    const blocks = out.messages[0]!.content;
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[1]!.type).toBe('image');
    expect(blocks[1]!.image?.base64).toBe('AAAA');
  });

  it('round-trips back to Anthropic with tool_use', () => {
    const canonical = {
      model: 'claude',
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
        { role: 'assistant' as const, content: [{ type: 'tool_use' as const, toolUse: { id: 't1', name: 'fn', input: { x: 1 } } }] },
      ],
      maxOutputTokens: 256,
      stream: false,
      tools: [{ name: 'fn', inputSchema: { type: 'object' } }],
    };
    const out = canonicalToAnthropicRequest(canonical, 'claude-3-5');
    expect(out.tools![0]!.name).toBe('fn');
    const assistant = out.messages[1]!;
    expect(Array.isArray(assistant.content)).toBe(true);
  });

  it('normalizes Anthropic response usage', () => {
    const r = anthropicResponseToCanonical({
      id: 'm', type: 'message', role: 'assistant', model: 'claude',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 },
    } as never, 'claude');
    expect(r.usage.input).toBe(7);
    expect(r.usage.output).toBe(3);
    expect(r.usage.cacheRead).toBe(2);
    expect(r.usage.cacheWrite).toBe(4);
    expect(r.finishReason).toBe('end_turn');
  });
});
