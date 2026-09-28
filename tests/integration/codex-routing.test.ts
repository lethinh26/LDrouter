// Legacy provider support was removed; retained as historical coverage.
import { describe, expect, it } from 'vitest';
import { codexStreamEventToClient } from '../../src/server/gateway/runner';

describe.skip('Codex routing integration seam', () => {
  it('keeps stream completion protocol-compatible', () => {
    const data = JSON.parse(codexStreamEventToClient('openai', { text: '', isLast: true }, 'gpt-5', 'req-1')) as { choices: Array<{ finish_reason: string }> };
    expect(data.choices[0]?.finish_reason).toBe('stop');
  });
});
