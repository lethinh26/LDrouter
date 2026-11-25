import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/server/errors';
import { classifyFailure, isQuotaFailure, isUpstreamHealthFailure, shouldRetryAttempt } from '../../src/server/gateway/runner';
import { shouldFallback, type ComboPlan } from '../../src/server/routing/combo';
import { upstreamHttpError } from '../../src/server/upstream/client';

class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`Upstream HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
}

const usageLimit = () => upstreamHttpError(429, 'The usage limit has been reached', { status: 429 });

describe('quota failure classification', () => {
  it('classifies an upstream usage-limit 429 as quota, not unknown', () => {
    expect(classifyFailure(usageLimit())).toBe('quota');
  });

  it('identifies quota failures directly', () => {
    expect(isQuotaFailure(usageLimit())).toBe(true);
  });

  it('does NOT route a quota failure through the provider circuit-breaker path', () => {
    expect(isUpstreamHealthFailure(usageLimit())).toBe(false);
  });

  it('does not reclassify ordinary client errors as quota', () => {
    const badRequest = new GatewayError('upstream_error', 'Invalid value: parameter', {
      status: 502,
      cause: new UpstreamStatusError(400),
    });
    expect(classifyFailure(badRequest)).toBe('unknown');
    expect(isUpstreamHealthFailure(badRequest)).toBe(false);
    expect(isQuotaFailure(badRequest)).toBe(false);
  });

  it('keeps a plain 429 rate limit distinct from exhausted quota', () => {
    const throttled = new GatewayError('upstream_rate_limit', 'Upstream rate limited (HTTP 429)', { status: 429 });
    expect(classifyFailure(throttled)).toBe('http_status');
    expect(isQuotaFailure(throttled)).toBe(false);
  });

  it('detects quota wording in an upstream message regardless of case', () => {
    const err = new GatewayError('upstream_error', 'Error: USAGE_LIMIT_REACHED for this workspace', {
      status: 502,
      cause: new UpstreamStatusError(429),
    });
    expect(isQuotaFailure(err)).toBe(true);
  });

  it('ignores quota wording on a non-quota status', () => {
    // A 400 whose body happens to mention "quota" is about the request, not exhausted upstream quota.
    const err = new GatewayError('upstream_error', 'Invalid value: quota field in request body', {
      status: 502,
      cause: new UpstreamStatusError(400),
    });
    expect(isQuotaFailure(err)).toBe(false);
  });
});

describe('quota fallback policy', () => {
  const combo: ComboPlan = {
    comboId: 'quota-policy', mode: 'fallback', maxTotalAttempts: 3,
    members: [{ id: 'm1', modelId: 'a', position: 0, enabled: true }],
    trigger: { connection: true, connectTimeout: true, firstTokenTimeout: true, totalTimeout: true, on408: true, on429: true, on5xx: true },
  };

  it('advances to the next candidate on a quota failure', () => {
    expect(shouldFallback(combo, { type: 'quota' })).toBe(true);
  });

  it('advances on quota exhaustion even when ordinary 429 fallback is disabled', () => {
    expect(shouldRetryAttempt({ ...combo, trigger: { ...combo.trigger, on429: false } }, usageLimit())).toBe(true);
  });

  it('still refuses to retry a non-quota failure for a direct model', () => {
    // No combo plan means no configured fallback policy: a plain bad request must not be retried.
    const badRequest = new GatewayError('upstream_error', 'Invalid value: parameter', {
      status: 502,
      cause: new UpstreamStatusError(400),
    });
    expect(shouldRetryAttempt(null, badRequest)).toBe(false);
  });

  it('classifies a 429 whose body carries the quota wording', () => {
    const err = upstreamHttpError(429, '{"error":{"message":"You exceeded your current quota"}}', { status: 429 });
    expect(isQuotaFailure(err)).toBe(true);
    expect(classifyFailure(err)).toBe('quota');
  });

  it('still treats a bare 429 throttle as a transient http_status failure', () => {
    const err = upstreamHttpError(429, '', { status: 429 });
    expect(isQuotaFailure(err)).toBe(false);
    expect(classifyFailure(err)).toBe('http_status');
    expect(shouldRetryAttempt(combo, err)).toBe(true);
    expect(shouldRetryAttempt({ ...combo, trigger: { ...combo.trigger, on429: false } }, err)).toBe(false);
  });

  it('preserves HTTP 408 as an http_status fallback decision', () => {
    const err = upstreamHttpError(408, 'request timeout', { status: 408 });
    expect(classifyFailure(err)).toBe('http_status');
    expect(shouldRetryAttempt({
      comboId: '408-policy', mode: 'fallback', maxTotalAttempts: 2,
      members: [{ id: 'm1', modelId: 'a', position: 0, enabled: true }],
      trigger: { connection: true, connectTimeout: true, firstTokenTimeout: true, totalTimeout: true, on408: true, on429: true, on5xx: true },
    }, err)).toBe(true);
    expect(shouldRetryAttempt({
      comboId: '408-disabled', mode: 'fallback', maxTotalAttempts: 2,
      members: [{ id: 'm1', modelId: 'a', position: 0, enabled: true }],
      trigger: { connection: true, connectTimeout: true, firstTokenTimeout: true, totalTimeout: true, on408: false, on429: true, on5xx: true },
    }, err)).toBe(false);
  });

  it('routes total timeouts through their own combo trigger and counts them for provider health', () => {
    const err = new GatewayError('timeout_error', 'Upstream total timeout', { status: 504, code: 'upstream_total_timeout' });
    expect(classifyFailure(err)).toBe('total_timeout');
    expect(isUpstreamHealthFailure(err)).toBe(true);
    const enabled = {
      comboId: 'total-timeout-enabled', mode: 'fallback' as const, maxTotalAttempts: 2,
      members: [{ id: 'm1', modelId: 'a', position: 0, enabled: true }],
      trigger: { connection: true, connectTimeout: true, firstTokenTimeout: true, totalTimeout: true, on408: true, on429: true, on5xx: true },
    };
    expect(shouldRetryAttempt(enabled, err)).toBe(true);
    expect(shouldRetryAttempt({ ...enabled, trigger: { ...enabled.trigger, totalTimeout: false } }, err)).toBe(false);

    const slow = new GatewayError('timeout_error', 'Combo slow response threshold exceeded', { status: 504, code: 'combo_slow_response_timeout' });
    expect(isUpstreamHealthFailure(slow)).toBe(false);
  });

  it('counts a post-content stream idle timeout as a provider health failure', () => {
    const idle = new GatewayError('timeout_error', 'Upstream stream idle timeout', {
      status: 504,
      code: 'upstream_stream_idle_timeout',
    });
    expect(classifyFailure(idle)).toBe('stream_idle_timeout');
    expect(isUpstreamHealthFailure(idle)).toBe(true);
  });
});
