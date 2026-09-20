import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  codexHeaders,
  codexModels,
  codexRequest,
  codexRequestPayload,
  codexResponseToCanonical,
  codexStreamEventToCanonical,
  probeCodex,
  withCodexUpstream,
  type CodexProviderConfig,
} from '../../src/server/providers/codex';

// restoreAllMocks does not un-stub stubGlobal; a leaked fetch stub breaks integration files.
afterEach(() => vi.unstubAllGlobals());

const config = (): CodexProviderConfig => ({
  baseUrl: 'https://chatgpt.com', accountId: 'acct-1', accessToken: 'access-secret',
  customHeaders: {}, totalTimeoutMs: 10_000,
});

describe('codexRequestPayload', () => {
  const req = (extra: Partial<import('../../src/server/routing/capabilities').CanonicalRequest> = {}) => ({
    model: 'codex/gpt-5.5',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    stream: true,
    ...extra,
  });

  it('always sends store:false and stream:true', () => {
    const payload = codexRequestPayload(req());
    expect(payload.store).toBe(false);
    expect(payload.stream).toBe(true);
    expect(payload.model).toBe('codex/gpt-5.5');
  });

  // The Codex backend answers 400 'Unsupported parameter: <name>' for each of these. Verified live
  // against chatgpt.com; the Models-page Test button failed with exactly this before the fix.
  it.each(['max_output_tokens', 'temperature', 'top_p'])('never forwards %s', (param) => {
    const payload = codexRequestPayload(req({ maxOutputTokens: 256, temperature: 0.7, topP: 0.9 }));
    expect(payload).not.toHaveProperty(param);
  });

  it('keeps the parameters the backend does accept', () => {
    const payload = codexRequestPayload(req({
      system: 'be terse',
      tools: [{ name: 'get_weather', description: 'w', inputSchema: { type: 'object' } }],
      reasoning: { effort: 'low' },
    }));
    expect(payload.instructions).toBe('be terse');
    expect(payload.reasoning).toEqual({ effort: 'low' });
    expect(payload.tools).toEqual([{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object' } }]);
  });
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

  it('ignores a stored base URL that does not host the Codex backend', () => {
    // Regression: providers created before Codex gained a default carried
    // https://api.openai.com, which 404s on /backend-api/codex/*.
    const legacy = { ...config(), baseUrl: 'https://api.openai.com' };
    expect(codexRequest(legacy, '/models')).toBe('https://chatgpt.com/backend-api/codex/models');
  });

  it('discovers models from the Codex model endpoint without importing them', async () => {
    // Real upstream shape: models are keyed by `slug`, not `id`.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex' },
        { slug: 'gpt-reserve', display_name: null },
        { display_name: 'No identifier, must be skipped' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await codexModels(config());
    expect(models).toEqual([
      { upstreamId: 'gpt-5-codex', displayName: 'GPT-5 Codex', capabilities: { responses: true, streaming: true, reasoning: true } },
      { upstreamId: 'gpt-reserve', displayName: 'gpt-reserve', capabilities: { responses: true, streaming: true, reasoning: true } },
    ]);
    // The endpoint rejects requests without the required client_version query parameter.
    const requested = String(fetchMock.mock.calls[0]![0]);
    expect(requested).toContain('/backend-api/codex/models?client_version=');
  });

  it('maps non-streaming responses and ignores unsupported fields', () => {
    expect(codexResponseToCanonical({ id: 'resp_1', model: 'gpt-5-codex', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 2, output_tokens: 3 }, unsupported_secret: 'nope' }, 'requested')).toMatchObject({ text: 'hello', model: 'requested', usage: { input: 2, output: 3, total: 5 } });
  });

  it('maps streaming events incrementally', () => {
    expect(codexStreamEventToCanonical({ type: 'response.output_text.delta', delta: 'hi' })).toEqual({ text: 'hi', isLast: false });
    expect(codexStreamEventToCanonical({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } })).toMatchObject({ isLast: true, usage: { input: 1, output: 2, total: 3 } });
  });

  // The Responses API nests these; reading only the flat names made every Codex request
  // report cacheRead/reasoning as 0 (1,381 requests — 46% of traffic — on live data), which
  // is most of why the statistics page's cache-hit rate was wrong.
  it('reads the nested cached/reasoning token details', () => {
    const body = {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 100, output_tokens: 40, total_tokens: 140,
          input_tokens_details: { cached_tokens: 75, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 25 },
        },
      },
    };
    expect(codexStreamEventToCanonical(body)).toMatchObject({ usage: { input: 100, output: 40, cacheRead: 75, reasoning: 25 } });
  });

  it('still accepts the flat names, and yields 0 when neither shape is present', () => {
    expect(codexResponseToCanonical({ output: [], usage: { input_tokens: 5, output_tokens: 1, cached_input_tokens: 4, reasoning_tokens: 1 } }, 'm'))
      .toMatchObject({ usage: { cacheRead: 4, reasoning: 1 } });
    expect(codexResponseToCanonical({ output: [], usage: { input_tokens: 5, output_tokens: 1 } }, 'm'))
      .toMatchObject({ usage: { cacheRead: 0, reasoning: 0 } });
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

  it('tags model-discovery HTTP failures with a status so the refresh-and-retry path can see them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })));
    // Without .status, isUnauthorized() cannot detect the 401 and a bare error escapes as a 500.
    await expect(codexModels(config())).rejects.toMatchObject({ status: 401 });
  });
});
