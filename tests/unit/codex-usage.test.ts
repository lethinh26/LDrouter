import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseCodexUsage, readCodexQuotas, fetchCodexUsage, fetchCodexResetCredits, consumeCodexResetCredit, pingCodexAccount } from '../../src/server/providers/codex-usage';

// restoreAllMocks does not un-stub stubGlobal; a leaked fetch stub breaks integration files
// that talk to a real test server.
afterEach(() => vi.unstubAllGlobals());

const usageBody = {
  plan_type: 'plus',
  rate_limit: { primary_window: { used_percent: 25, reset_at: 1_800_000_000 }, secondary_window: { used_percent: 90 }, limit_reached: false },
  rate_limit_reset_credits: { available_count: 2 },
};

describe('Codex usage parsing', () => {
  it('maps primary/secondary windows to 5h and weekly quotas with remaining percentage', () => {
    const usage = parseCodexUsage(usageBody);
    expect(usage.plan).toBe('plus');
    expect(usage.resetCredits).toBe(2);
    expect(usage.quotas.session).toMatchObject({ used: 25, total: 100, remaining: 75 });
    expect(usage.quotas.blocking).toMatchObject({ used: 90, remaining: 10 });
    expect(usage.quotas.session!.resetAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it('reads windows from the alternate upstream spellings', () => {
    const quotas = readCodexQuotas({ rate_limit: { primary_window: { used_percent: 100, resets_at: '2030-01-01T00:00:00.000Z' } } });
    expect(quotas.session).toMatchObject({ used: 100, remaining: 0, resetAt: '2030-01-01T00:00:00.000Z' });
    expect(quotas.blocking).toBeUndefined();
  });

  it('falls back to a zeroed window for unknown bodies instead of throwing', () => {
    expect(parseCodexUsage(null).quotas).toEqual({});
    expect(parseCodexUsage({ rate_limit: { used_percent: 'abc' } }).quotas.session).toMatchObject({ used: 0, remaining: 100 });
  });

  it('sends the Codex CLI auth headers and returns a status error on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(usageBody), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchCodexUsage('tok', 'acct');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage');
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['openai-beta']).toBe('codex-1');
    expect(headers['chatgpt-account-id']).toBe('acct');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await expect(fetchCodexUsage('tok')).rejects.toThrow('Codex usage API returned HTTP 503');
  });

  it('normalizes reset credit listings and surfaces a 409 as a credential-free error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ available_count: 1, credits: [{ status: 'available', granted_at: '2030-01-01T00:00:00Z' }] }), { status: 200 })));
    const credits = await fetchCodexResetCredits('tok');
    expect(credits.availableCount).toBe(1);
    expect(credits.credits[0]).toMatchObject({ status: 'available', grantedAt: '2030-01-01T00:00:00.000Z', expiresAt: null });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'no_credit' }), { status: 409 })));
    await expect(consumeCodexResetCredit('tok')).rejects.toThrow('No Codex reset credits available');
  });

  it('reports a consumed reset credit and requires a redeem request id in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'reset', windows_reset: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await consumeCodexResetCredit('tok', 'acct');
    expect(result).toMatchObject({ ok: true, noCredit: false, code: 'reset', windowsReset: 2 });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toMatch(/^\{.*"redeem_request_id":".+"\}$/);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  });
});

describe('Codex 5h window auto-start ping', () => {
  const cfg = { baseUrl: 'https://chatgpt.com', accountId: 'a1', accessToken: 'tok', customHeaders: {}, totalTimeoutMs: 5_000 };

  it('drains the stream so the 5h window actually starts', async () => {
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 2) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(pingCodexAccount(cfg)).resolves.toBe(true);
    // 3 pulls proves the body was read to completion rather than abandoned after headers.
    expect(pulled).toBe(3);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ model: 'gpt-5.5', stream: true, store: false });
  });

  it('returns false on a non-2xx ping response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 429 })));
    await expect(pingCodexAccount(cfg)).resolves.toBe(false);
  });
});
