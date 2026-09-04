// Simple unit test for Claude Code compatibility fixes
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('Zod Passthrough', () => {
  const ChatBody = z.object({
    model: z.string().min(1),
    messages: z.array(z.any()).min(1),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().min(1).optional(),
    max_completion_tokens: z.number().int().min(1).optional(),
    stop: z.union([z.array(z.string()), z.string()]).optional(),
    response_format: z.any().optional(),
    reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
    parallel_tool_calls: z.any().optional(),
    stream_options: z.any().optional(),
    metadata: z.any().optional(),
    seed: z.number().int().optional(),
    service_tier: z.any().optional(),
  }).passthrough();

  const MessagesBody = z.object({
    model: z.string().min(1),
    messages: z.array(z.any()).min(1),
    system: z.union([z.string(), z.array(z.any())]).optional(),
    max_tokens: z.number().int().min(1).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional(),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    thinking: z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().min(1) }).optional(),
  }).passthrough();

  it('accepts extra fields in OpenAI chat completion', () => {
    const payload = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      parallel_tool_calls: true,
      max_completion_tokens: 1000,
      stream_options: { include_usage: true },
      metadata: { source: 'claude-code' },
      seed: 42,
      service_tier: 'auto',
      unknown_field: 'should pass'
    };

    const result = ChatBody.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts extra fields in Anthropic messages', () => {
    const payload = {
      model: 'test-claude',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 50 },
      extra_field: 'should pass'
    };

    const result = MessagesBody.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const payload = {
      messages: [{ role: 'user', content: 'Hi' }] // missing model
    };

    const result = ChatBody.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe('Capability undefined handling', () => {
  function modelMeets(caps: Record<string, boolean | undefined>, req: Record<string, boolean>): boolean {
    if (req.streaming && caps.streaming === false) return false;
    if (req.tools && caps.tools === false) return false;
    if (req.structuredOutput && caps.structured_output === false) return false;
    if (req.imageInput && caps.image_input === false) return false;
    if (req.audioInput && caps.audio_input === false) return false;
    if (req.reasoning && caps.reasoning === false) return false;
    if (req.responses && caps.responses === false) return false;
    return true;
  }

  it('allows model with undefined capabilities (unknown but potentially supported)', () => {
    const caps = {
      streaming: true,
      tools: undefined, // Not explicitly imported
      image_input: undefined,
      structured_output: undefined,
    };
    const req = {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: false,
      audioInput: false,
      reasoning: false,
      responses: false,
    };

    expect(modelMeets(caps, req)).toBe(true);
  });

  it('rejects only when capability is explicitly false', () => {
    const caps = {
      streaming: true,
      tools: false, // Explicitly disabled
      image_input: true,
    };
    const req = {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: false,
      audioInput: false,
      reasoning: false,
      responses: false,
    };

    expect(modelMeets(caps, req)).toBe(false);
  });

  it('allows vision model even without explicit "vision" keyword in ID', () => {
    const caps = {
      streaming: true,
      image_input: undefined, // Didn't infer from ID pattern
      tools: true,
    };
    const req = {
      streaming: true,
      imageInput: true, // Request has image content
      tools: false,
      structuredOutput: false,
      audioInput: false,
      reasoning: false,
      responses: false,
    };

    expect(modelMeets(caps, req)).toBe(true);
  });
});

describe('Safe JSON parsing', () => {
  function safeJson(s: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(s);
      const result: Record<string, unknown> = {
        chat: true,
        streaming: true,
        tools: true,
        structured_output: true,
        image_input: true,
        audio_input: true,
        reasoning: true,
        responses: true,
        ...parsed,
      };
      return result;
    } catch {
      return {
        chat: true,
        streaming: true,
        tools: true,
        structured_output: true,
        image_input: true,
        audio_input: true,
        reasoning: true,
        responses: true,
      };
    }
  }

  it('returns complete defaults on parse error', () => {
    const result = safeJson('{ invalid json }');
    expect(result.chat).toBe(true);
    expect(result.streaming).toBe(true);
    expect(result.tools).toBe(true);
    expect(result.image_input).toBe(true);
  });

  it('merges with parsed values', () => {
    const result = safeJson(JSON.stringify({ tools: false, reasoning: true }));
    expect(result.chat).toBe(true); // default
    expect(result.tools).toBe(false); // merged
    expect(result.reasoning).toBe(true); // merged
  });

  it('handles null input gracefully', () => {
    // Test the edge case where s might be null/undefined
    expect(() => safeJson(String(null))).not.toThrow();
  });
});