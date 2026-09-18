import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/server/errors';
import { classifyFailure, isQuotaFailure, isUpstreamHealthFailure, markQuotaExhausted, shouldRetryAttempt } from '../../src/server/gateway/runner';
import { expandCodexAccountCandidates, expandQoderAccountCandidates, shouldFallback, type ComboPlan } from '../../src/server/routing/combo';
import { upstreamHttpError } from '../../src/server/upstream/client';

/**
 * Quota exhaustion is a durable, account-level verdict — not a transient provider blip.
 *
 * Live evidence (production, 2026-09-17): an exhausted Codex account was retried on every request
 * for hours (`Codex upstream HTTP 429: The usage limit has been reached`, the same
 * `codex_account_id` each time) and every one was recorded as `failure_reason=unknown`. Same shape
 * for Qoder (`Qoder account is out of quota`, the same `qoder_account_id` hour after hour).
 *
 * `unknown` is not a routing decision: `isUpstreamHealthFailure` excludes it and `shouldFallback`
 * returns false for it, so the pool kept selecting the dead account and answered "usage limited".
 */
class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`Upstream HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
}

/** Exactly what the Codex path produces: responseError() throws a bare Error carrying status. */
const codexUsageLimit = () =>
  new GatewayError('upstream_error', 'Codex upstream HTTP 429: The usage limit has been reached', {
    status: 502,
    cause: new UpstreamStatusError(429),
  });

const qoderBillingBlock = () =>
  new GatewayError('upstream_error', 'Qoder account is out of quota', { status: 502, code: 'qoder_billing_block' });

describe('quota failure classification', () => {
  it('classifies a Codex usage-limit 429 as quota, not unknown', () => {
    expect(classifyFailure(codexUsageLimit())).toBe('quota');
  });

  it('classifies a Qoder billing block as quota, not unknown', () => {
    expect(classifyFailure(qoderBillingBlock())).toBe('quota');
  });

  it('identifies quota failures directly', () => {
    expect(isQuotaFailure(codexUsageLimit())).toBe(true);
    expect(isQuotaFailure(qoderBillingBlock())).toBe(true);
  });

  it('does NOT route a quota failure through the provider circuit-breaker path', () => {
    // The provider here owns a pool of accounts and only one of them is out of quota. Reporting
    // this as a provider-level health failure would open the circuit for every sibling account
    // that can still serve. The exhaustion is handled account-by-account instead.
    expect(isUpstreamHealthFailure(codexUsageLimit())).toBe(false);
    expect(isUpstreamHealthFailure(qoderBillingBlock())).toBe(false);
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

  it('keeps a plain 429 rate limit distinct from an exhausted quota account', () => {
    // Throttling is transient: the account stays eligible, so it must never be disabled the way an
    // exhausted quota account is.
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

  it('ignores quota wording on a non-quota status to avoid disabling a healthy account', () => {
    // A 400 whose body happens to mention "quota" is about the request, not an empty account.
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
    members: [{ id: 'm1', modelId: 'a', position: 0, weight: 1, enabled: true }],
    trigger: { connection: true, connectTimeout: true, firstTokenTimeout: true, on408: true, on429: true, on5xx: true },
  };

  it('advances to the next candidate on a quota failure', () => {
    // Without this, `shouldFallback` falls through to `default: false` and the request ends on the
    // exhausted account instead of trying the next one.
    expect(shouldFallback(combo, { type: 'quota' })).toBe(true);
  });

  it('advances even for a direct model with no combo plan', () => {
    // The reported case: `33 x model model=qoder/...` — a direct qoder model, not a combo. Before the
    // fix the retry was gated on `comboPlan ? … : false`, so the request never left the exhausted
    // account and the client got "usage limited" while a healthy account sat idle in the pool.
    expect(shouldRetryAttempt(null, codexUsageLimit())).toBe(true);
    expect(shouldRetryAttempt(null, qoderBillingBlock())).toBe(true);
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
    // OpenAI-compatible providers answer quota exhaustion with a plain 429 and put the reason in the
    // body. `upstreamHttpError` used to drop that body, so the account was never disabled.
    const err = upstreamHttpError(429, '{"error":{"message":"You exceeded your current quota"}}', { status: 429 });
    expect(isQuotaFailure(err)).toBe(true);
    expect(classifyFailure(err)).toBe('quota');
  });

  it('still treats a bare 429 throttle as a transient http_status failure', () => {
    // No quota wording means a real rate limit: retry the same account, do NOT disable it.
    const err = upstreamHttpError(429, '', { status: 429 });
    expect(isQuotaFailure(err)).toBe(false);
    expect(classifyFailure(err)).toBe('http_status');
  });
});

/**
 * Ask B in the report: an exhausted account must be disabled, not merely annotated. The account is
 * marked down *and* disabled, and the pool expansion then stops offering it — which is what makes
 * the next request land on a different account.
 */
describe('quota exhaustion disables the account and frees the pool', () => {
  it('writes the verdict and removes the account from both pools', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { closeDb, openDb, getRawDb } = await import('../../src/server/db');
    const { setConfigMasterKey } = await import('../../src/server/config');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-quota-disable-'));
    const savedKey = process.env.LATEDEV_MASTER_KEY;
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    try {
      const raw = getRawDb();
      raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('cp','Codex','cp','codex','https://chatgpt.com')").run();
      raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('qp','Qoder','qp','qoder','https://api2.qoder.sh')").run();

      const codexRepo = await import('../../src/server/db/repositories/codex-accounts');
      const qoderRepo = await import('../../src/server/db/repositories/qoder-accounts');
      const { parseCodexImportText } = await import('../../src/server/providers/codex-import');
      const codexRecord = parseCodexImportText(JSON.stringify({
        access_token: 'access-token', refresh_token: 'refresh-token', email: 'quota@example.com',
        chatgpt_account_id: 'acct-quota', chatgpt_plan_type: 'plus',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }))[0] as never;
      const codexId = codexRepo.insertCodexAccount('cp', codexRecord);
      const qoderId = qoderRepo.insertQoderAccount('qp', {
        index: 0, personalToken: 'pt-x', jobToken: 'jt-x', jobTokenExpiresAt: '2026-09-18T00:00:00.000Z',
        qoderUserId: 'u1', machineId: 'm1', email: null, label: null, source: undefined,
      });

      // Both accounts are healthy and offered by the pool before the verdict.
      const codexCandidate = (id: string) => ({ modelId: 'cm', publicModelId: 'codex/gpt', providerId: 'cp', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {}, providerType: 'codex', codexAccountId: id, codexChatgptAccountId: 'acct-quota' });
      const qoderCandidate = (id: string) => ({ modelId: 'qm', publicModelId: 'qoder/qmodel', providerId: 'qp', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {}, providerType: 'qoder', qoderAccountId: id, qoderUserId: 'u1' });
      expect(expandCodexAccountCandidates(codexCandidate(codexId), codexRepo.listCodexAccountsForProvider('cp'))).toHaveLength(1);
      expect(expandQoderAccountCandidates(qoderCandidate(qoderId), qoderRepo.listQoderAccountsForProvider('qp'))).toHaveLength(1);

      markQuotaExhausted(codexCandidate(codexId), 'Codex upstream HTTP 429: The usage limit has been reached');
      markQuotaExhausted(qoderCandidate(qoderId), 'Qoder account is out of quota');

      const codexRow = raw.prepare('SELECT enabled, health_state AS h, last_error AS e FROM codex_accounts WHERE id=?').get(codexId) as { enabled: number; h: string; e: string | null };
      expect(codexRow.enabled).toBe(0);
      expect(codexRow.h).toBe('down');
      expect(codexRow.e).toContain('usage limit');

      const qoderRow = raw.prepare('SELECT enabled, health_state AS h, last_error AS e FROM qoder_accounts WHERE id=?').get(qoderId) as { enabled: number; h: string; e: string | null };
      expect(qoderRow.enabled).toBe(0);
      expect(qoderRow.h).toBe('down');

      // The exhausted account is no longer a candidate: the next request must land elsewhere.
      expect(expandCodexAccountCandidates(codexCandidate(codexId), codexRepo.listCodexAccountsForProvider('cp'))).toHaveLength(0);
      expect(expandQoderAccountCandidates(qoderCandidate(qoderId), qoderRepo.listQoderAccountsForProvider('qp'))).toHaveLength(0);
      expect(codexRepo.getCodexAccountById(codexId)).toBeNull();
      expect(qoderRepo.findEligibleQoderAccount('qp')).toBeNull();
    } finally {
      closeDb();
      if (savedKey === undefined) delete process.env.LATEDEV_MASTER_KEY;
      else process.env.LATEDEV_MASTER_KEY = savedKey;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});