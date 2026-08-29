// Unit tests: capability derivation.
import { describe, expect, it } from 'vitest';
import { deriveRequiredCapabilities, modelMeets } from '../../src/server/routing/capabilities';

describe('capability derivation', () => {
  it('detects tools', () => {
    const r = deriveRequiredCapabilities({
      model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], stream: false,
      tools: [{ name: 'fn', inputSchema: {} }],
    });
    expect(r.tools).toBe(true);
  });

  it('detects tool_use/tool_result blocks', () => {
    const r = deriveRequiredCapabilities({
      model: 'm', messages: [
        { role: 'assistant', content: [{ type: 'tool_use', toolUse: { id: 't1', name: 'fn', input: {} } }] },
        { role: 'user', content: [{ type: 'tool_result', toolResult: { toolUseId: 't1', content: 'done' } }] },
      ], stream: false,
    });
    expect(r.tools).toBe(true);
  });

  it('detects image and structured output', () => {
    const r = deriveRequiredCapabilities({
      model: 'm', messages: [{ role: 'user', content: [{ type: 'image', image: { url: 'x' } }] }],
      stream: false, responseFormat: { type: 'json_schema', jsonSchema: {} },
    });
    expect(r.imageInput).toBe(true);
    expect(r.structuredOutput).toBe(true);
  });

  it('modelMeets gates correctly', () => {
    const req = { streaming: true, tools: true, structuredOutput: false, imageInput: false, audioInput: false, reasoning: false, responses: false };
    expect(modelMeets({ streaming: true, tools: true }, req)).toBe(true);
    expect(modelMeets({ streaming: true, tools: false }, req)).toBe(false);
    expect(modelMeets({ streaming: false, tools: true }, req)).toBe(false);
  });
});
