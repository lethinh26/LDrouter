import { describe, expect, it } from 'vitest';
import { deserializeCatalog, parseCatalog, serializeCatalog } from '../../src/server/providers/qoder/catalog';
import { parseQoderCredits } from '../../src/server/providers/qoder/credits';

// `is_free` is the promotion flag: Qwen3.8-Max is covered by Qoder's promo, so an account with
// zero Credits still answers on it. Derived from a real /algo/api/v2/model/list response.
const liveList = {
  chat: [
    { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, is_free: true, is_reasoning: true, max_input_tokens: 180000 },
    { key: 'dmodel', display_name: 'DeepSeek-V4-Pro', enable: true, is_free: false, max_input_tokens: 180000 },
    { key: 'auto', display_name: 'Auto', enable: true, price_factor: 1 },
  ],
};

describe('Qoder catalog is_free', () => {
  it('reads the promotion flag off the live list and round-trips it through the cache', () => {
    const catalog = parseCatalog(liveList, '2026-09-17T12:00:00.000Z');
    expect(catalog.entries.get('qmodel_38max')!.isFree).toBe(true);
    expect(catalog.entries.get('dmodel')!.isFree).toBe(false);
    // Absent flag is "not free", never undefined.
    expect(catalog.entries.get('auto')!.isFree).toBe(false);
    expect(deserializeCatalog(serializeCatalog(catalog))!.entries.get('qmodel_38max')!.isFree).toBe(true);
  });

  it('re-derives is_free for catalogs cached before the field existed', () => {
    const cached = JSON.stringify({
      fetchedAt: '2026-09-16T00:00:00.000Z',
      entries: [{ key: 'qmodel_38max', displayName: 'Qwen3.8-Max', enabled: true, isReasoning: true, isVl: true, maxInputTokens: 180000, maxOutputTokens: 0, raw: { is_free: true } }],
    });
    expect(deserializeCatalog(cached)!.entries.get('qmodel_38max')!.isFree).toBe(true);
  });
});

// Shaped from a real openapi /api/v2/quota/usage response: Qoder reports Credits, never tokens.
const liveUsageBody = {
  userId: '01a05e1f-56a1-741c-a486-30407e8d095a',
  userType: 'personal_standard',
  usageType: 'credits',
  totalUsagePercentage: 0,
  isQuotaExceeded: true,
  expiresAt: 253402214400000,
  upgradeUrl: 'https://qoder.com/pricing?client=qoder',
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
};

describe('parseQoderCredits', () => {
  it('reports an exhausted account with no plan credits', () => {
    const credits = parseQoderCredits(liveUsageBody, ['qmodel_38max'], '2026-09-17T12:00:00.000Z');
    expect(credits.userType).toBe('personal_standard');
    expect(credits.exhausted).toBe(true);
    expect(credits.buckets).toEqual([]);
    // The far-future sentinel means "no expiry", not year 9999.
    expect(credits.expiresAt).toBeNull();
    expect(credits.upgradeUrl).toBe('https://qoder.com/pricing?client=qoder');
    expect(credits.freeModels).toEqual(['qmodel_38max']);
  });

  it('keeps plan, add-on and org buckets that carry a total', () => {
    const credits = parseQoderCredits(
      {
        userType: 'personal_pro',
        isQuotaExceeded: false,
        totalUsagePercentage: 25,
        expiresAt: 1_790_000_000_000,
        userQuota: { total: 2000, used: 500, remaining: 1500, unit: 'credits' },
        addOnQuota: { total: 1500, used: 0, remaining: 1500, unit: 'credits' },
        orgResourcePackage: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      },
      [],
      '2026-09-17T12:00:00.000Z',
    );
    expect(credits.buckets.map((bucket) => bucket.label)).toEqual(['Plan credits', 'Add-on credits']);
    expect(credits.buckets[0]).toMatchObject({ total: 2000, used: 500, remaining: 1500 });
    expect(credits.exhausted).toBe(false);
    expect(credits.expiresAt).toBe(new Date(1_790_000_000_000).toISOString());
  });

  it('falls back to derived remaining and treats a missing body as unknown', () => {
    const credits = parseQoderCredits({ userQuota: { total: 100, used: 30 } }, [], '2026-09-17T12:00:00.000Z');
    expect(credits.buckets[0]).toMatchObject({ remaining: 70, unit: 'credits' });
    expect(parseQoderCredits(null, [], '2026-09-17T12:00:00.000Z')).toMatchObject({ userType: 'unknown', exhausted: false, buckets: [] });
  });
});
