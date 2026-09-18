import { describe, expect, it } from 'vitest';
import { expandQoderAccountCandidates, type QoderAccountCandidate } from '../../src/server/routing/combo';

const candidate = { modelId: 'm1', providerId: 'qp', publicModelId: 'qoder/qmodel_38max', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {}, providerType: 'qoder' };
const accounts: QoderAccountCandidate[] = [
  { id: 'b', qoderUserId: 'u2', enabled: true, healthState: 'healthy', priority: 2 },
  { id: 'a', qoderUserId: 'u1', enabled: true, healthState: 'healthy', priority: 1 },
  { id: 'c', qoderUserId: 'u3', enabled: false, healthState: 'healthy', priority: 0 },
  { id: 'd', qoderUserId: 'u4', enabled: true, healthState: 'down', priority: 0 },
];

describe('Qoder account candidate expansion', () => {
  it('yields one candidate per eligible account in priority order', () => {
    expect(expandQoderAccountCandidates(candidate, accounts).map((c) => c.qoderAccountId)).toEqual(['a', 'b']);
  });

  it('leaves a non-Qoder model untouched', () => {
    const other = { ...candidate, providerType: 'openai', publicModelId: 'openai/gpt-test' };
    expect(expandQoderAccountCandidates(other, accounts)).toEqual([other]);
  });

  it('respects the provider type rather than a hardcoded slug prefix', () => {
    // A Qoder provider whose slug is not literally `qoder` still expands.
    const custom = { ...candidate, publicModelId: 'my-qoder/qmodel_38max' };
    expect(expandQoderAccountCandidates(custom, accounts).map((c) => c.qoderAccountId)).toEqual(['a', 'b']);
  });

  it('keeps a degraded account eligible and drops only down or disabled ones', () => {
    // degraded is a warning (a previous billing/quota block), not a verdict: the runner retries it.
    const mixed = [...accounts, { id: 'e', qoderUserId: 'u5', enabled: true, healthState: 'degraded', priority: 3 }];
    expect(expandQoderAccountCandidates(candidate, mixed).map((c) => c.qoderAccountId)).toEqual(['a', 'b', 'e']);
  });
});

// A quota refusal arrives as an envelope carrying status 403 (code 112), so classifying by status
// alone reports it as a rejected credential. That mislabels the cause and force-re-exchanges a good
// PAT on every request. Billing must win over the 401/403 branch.
describe('Qoder attempt failure classification', () => {
  it('reports a billing block as quota, not as a rejected token', async () => {
    const { closeDb, openDb, getRawDb } = await import('../../src/server/db');
    const { setConfigMasterKey } = await import('../../src/server/config');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-qoder-billing-'));
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    try {
      getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('qp','Qoder','qp','qoder','https://api2.qoder.sh')").run();
      const repo = await import('../../src/server/db/repositories/qoder-accounts');
      const id = repo.insertQoderAccount('qp', {
        index: 0, personalToken: 'pt-x', jobToken: 'jt-x', jobTokenExpiresAt: '2026-09-18T00:00:00.000Z',
        qoderUserId: 'u1', machineId: 'm1', email: null, label: null, source: undefined,
      });
      const { qoderAttemptFailure } = await import('../../src/server/providers/qoder/credentials');
      await expect(qoderAttemptFailure(id, { status: 403, message: 'quota exceeded', billing: true })).rejects.toMatchObject({ code: 'qoder_billing_block' });
      const after = repo.listQoderAccountSummaries('qp')[0]!;
      // down AND disabled: a depleted account cannot serve paid models until Credits refill, so it
      // leaves the pool instead of being retried on every request (which showed the client
      // "usage limited" while the same account was selected again and again).
      expect(after.healthState).toBe('down');
      expect(after.enabled).toBe(false);
      expect(after.lastError).toContain('Credits');
      expect(getRawDb().prepare('SELECT 1').get()).toBeTruthy();
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
