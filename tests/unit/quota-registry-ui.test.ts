import { describe, expect, it } from 'vitest';
import { extractCodexQuotaResult, quotaIsStale } from '../../src/web/app/pages/quota-registry';

describe('quota snapshot UI', () => {
  it('extracts the app-server result without sending unrelated metadata', () => {
    const parsed = extractCodexQuotaResult(JSON.stringify({ id: 7, result: {
      accountId: 'fixture', accessToken: 'not-quota',
      rateLimits: { primary: { usedPercent: 32, extra: 'not-quota' } },
      rateLimitsByLimitId: { codex: { secondary: { usedPercent: 90, windowDurationMins: 10080 }, credit: 'not-quota' } },
    } }));
    expect(parsed).toMatchObject({ accountId: 'fixture', rateLimits: { primary: { usedPercent: 32 } }, rateLimitsByLimitId: { codex: { secondary: { usedPercent: 90, windowDurationMins: 10080 } } } });
    expect(JSON.stringify(parsed)).not.toContain('not-quota');
    expect(() => extractCodexQuotaResult('{"result":null}')).toThrow();
    expect(() => extractCodexQuotaResult('x'.repeat(32769))).toThrow();
  });
  it('marks observations stale after fifteen minutes or a reported reset, without assuming recovery', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    const snapshot = {
      source: 'manual' as const, observedAt: new Date(now - 1000).toISOString(), plan: null,
      ordinaryUsageAllowed: null, windows: [{ label: 'Weekly', usedPercent: 100, windowDurationMins: 10080, resetsAt: null as string | null }],
    };
    expect(quotaIsStale(snapshot, now)).toBe(false);
    expect(quotaIsStale(snapshot, now + 15 * 60000)).toBe(true);
    snapshot.windows[0]!.resetsAt = new Date(now - 100).toISOString();
    expect(quotaIsStale(snapshot, now)).toBe(true);
    expect(snapshot.windows[0]!.usedPercent).toBe(100);
  });
});
