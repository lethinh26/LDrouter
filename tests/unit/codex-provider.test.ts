import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  codexHeaders,
  codexModels,
  codexRequest,
  codexResponseToCanonical,
  codexStreamEventToCanonical,
  probeCodex,
  withCodexUpstream,
  type CodexProviderConfig,
} from '../../src/server/providers/codex';

afterEach(() => vi.restoreAllMocks());

const config = (): CodexProviderConfig => ({
  baseUrl: 'https://chatgpt.com', accountId: 'acct-1', accessToken: 'access-secret',
  customHeaders: {}, totalTimeoutMs: 10_000,
});

describe('Codex upstream adapter', () => {
  it('uses the Codex endpoint and required headers', () => {
    expect(codexHeaders(config())).toMatchObject({
      authorization: 'Bearer access-secret',
      'chatgpt-account-id': 'acct-1',
      originator: 'codex_cli_rs',
      'openai-beta': 'responses=experimental',
      accept: 'application/json',
    });
    expect(codexRequest(config(), '/responses')).toBe('https://chatgpt.com/backend-api/codex/responses');
  });

  it('discovers models from the Codex model endpoint without importing them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }] }), { status: 200 })));
    const models = await codexModels(config());
    expect(models).toEqual([{ upstreamId: 'gpt-5-codex', displayName: 'GPT-5 Codex', capabilities: { responses: true, streaming: true, reasoning: true } }]);
  });

  it('maps non-streaming responses and ignores unsupported fields', () => {
    expect(codexResponseToCanonical({ id: 'resp_1', model: 'gpt-5-codex', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 2, output_tokens: 3 }, unsupported_secret: 'nope' }, 'requested')).toMatchObject({ text: 'hello', model: 'requested', usage: { input: 2, output: 3, total: 5 } });
  });

  it('maps streaming events incrementally', () => {
    expect(codexStreamEventToCanonical({ type: 'response.output_text.delta', delta: 'hi' })).toEqual({ text: 'hi', isLast: false });
    expect(codexStreamEventToCanonical({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } })).toMatchObject({ isLast: true, usage: { input: 1, output: 2, total: 3 } });
  });

  it('refreshes and retries unauthorized calls exactly once', async () => {
    const refresh = vi.fn().mockResolvedValue({ ok: true, expiresAt: '2099-01-01T00:00:00.000Z' });
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 })).mockResolvedValueOnce('ok');
    await expect(withCodexUpstream('account-1', refresh, call)).resolves.toBe('ok');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry a second unauthorized response', async () => {
    const refresh = vi.fn().mockResolvedValue({ ok: true, expiresAt: '2099-01-01T00:00:00.000Z' });
    const call = vi.fn().mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 403 }));
    await expect(withCodexUpstream('account-1', refresh, call)).rejects.toMatchObject({ status: 403 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('probes the Codex models endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ id: 'gpt-5-codex' }] }), { status: 200 })));
    await expect(probeCodex(config())).resolves.toMatchObject({ ok: true, modelCount: 1 });
  });
});
