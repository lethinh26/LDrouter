import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/server/errors';
import { classifyFailure, isUpstreamHealthFailure } from '../../src/server/gateway/runner';
import { expandCodexAccountCandidates, orderCandidates, type CodexAccountCandidate, type ComboPlan, type CandidateModel } from '../../src/server/routing/combo';

class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`Upstream HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
}

describe('Codex account routing', () => {
  const accounts: CodexAccountCandidate[] = [
    { id: 'a', chatgptAccountId: 'chat-a', enabled: true, healthState: 'healthy', tokenExpiresAt: '2099-01-01T00:00:00.000Z', priority: 1 },
    { id: 'b', chatgptAccountId: 'chat-b', enabled: true, healthState: 'down', tokenExpiresAt: '2099-01-01T00:00:00.000Z', priority: 0 },
    { id: 'c', chatgptAccountId: 'chat-c', enabled: true, healthState: 'unknown', tokenExpiresAt: '2000-01-01T00:00:00.000Z', priority: 2 },
  ];
  it('filters unusable accounts and preserves priority order', () => {
    const result = expandCodexAccountCandidates({ modelId: 'm', publicModelId: 'codex/gpt', providerId: 'p', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {} }, accounts, new Date('2026-01-01T00:00:00.000Z'));
    expect(result.map((x) => x.codexAccountId)).toEqual(['a']);
  });
  it('does not expand non-Codex candidates', () => {
    const candidate = { modelId: 'm', publicModelId: 'openai/gpt', providerId: 'p', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {} } as const;
    expect(expandCodexAccountCandidates(candidate, accounts)).toEqual([candidate]);
  });

  it.each([400, 401, 403])('does not mark normal upstream HTTP %s as a health failure', (status) => {
    const error = new GatewayError('upstream_error', `Upstream HTTP ${status}`, {
      status: 502,
      cause: new UpstreamStatusError(status),
    });
    expect(classifyFailure(error)).toBe('unknown');
    expect(isUpstreamHealthFailure(error)).toBe(false);
  });

  it.each([
    ['connection', new GatewayError('upstream_unavailable', 'connection failed'), 'connection_error'],
    ['timeout', new GatewayError('timeout_error', 'Upstream first token timeout'), 'first_token_timeout'],
    ['429', new GatewayError('upstream_rate_limit', 'Upstream rate limited', { status: 529 }), 'http_status'],
    ['5xx', new GatewayError('upstream_error', 'Upstream HTTP 503', { status: 502, cause: new UpstreamStatusError(503) }), 'http_status'],
  ])('marks %s as an upstream health failure', (_label, error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
    expect(isUpstreamHealthFailure(error)).toBe(true);
  });

  it('uses configured member weights for deterministic weighted selection', () => {
    const combo: ComboPlan = {
      comboId: 'weighted-test', mode: 'weighted_round_robin', maxTotalAttempts: 2,
      members: [
        { id: 'member-a', modelId: 'a', position: 0, weight: 2, enabled: true },
        { id: 'member-b', modelId: 'b', position: 1, weight: 1, enabled: true },
      ],
      trigger: { connection: true, connectTimeout: true, firstTokenTimeout: true, on408: true, on429: true, on5xx: true },
    };
    const candidates = [
      { modelId: 'a', publicModelId: 'openai/a', providerId: 'p', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {} },
      { modelId: 'b', publicModelId: 'openai/b', providerId: 'p', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {} },
    ] satisfies CandidateModel[];
    const first = orderCandidates(combo, candidates);
    const second = orderCandidates(combo, candidates);
    const third = orderCandidates(combo, candidates);
    expect([first[0]?.modelId, second[0]?.modelId, third[0]?.modelId]).toEqual(['a', 'a', 'b']);
  });
});
