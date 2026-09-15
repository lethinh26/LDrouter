import { describe, expect, it } from 'vitest';
import { codexStreamEventToClient } from '../../src/server/gateway/runner';

describe('Codex gateway stream mapping', () => {
  it('maps Codex deltas and completion to OpenAI-compatible downstream chunks', () => {
    const delta = codexStreamEventToClient('openai', { text: 'hello', isLast: false }, 'gpt-5-codex', 'req-1');
    const done = codexStreamEventToClient('openai', { text: '', isLast: true }, 'gpt-5-codex', 'req-1');
    expect(JSON.parse(delta)).toMatchObject({ object: 'chat.completion.chunk', choices: [{ delta: { content: 'hello' }, finish_reason: null }] });
    expect(JSON.parse(done)).toMatchObject({ object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] });
  });

  it('maps Codex deltas and completion to Anthropic-compatible downstream events', () => {
    const delta = codexStreamEventToClient('anthropic', { text: 'hello', isLast: false }, 'gpt-5-codex', 'req-1');
    const done = codexStreamEventToClient('anthropic', { text: '', isLast: true }, 'gpt-5-codex', 'req-1');
    expect(JSON.parse(delta)).toMatchObject({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } });
    expect(JSON.parse(done)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  });
});
