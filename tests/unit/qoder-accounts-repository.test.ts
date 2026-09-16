import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getRawDb, openDb } from '../../src/server/db';
import { resetConfigForTests, setConfigMasterKey } from '../../src/server/config';
import {
  findEligibleQoderAccount,
  getQoderAccountRefreshState,
  getQoderCredentials,
  insertQoderAccount,
  listQoderAccountSummaries,
  maskQoderValue,
  persistQoderJobToken,
  readQoderCatalog,
  setQoderAccountHealth,
  toQoderAccountSummary,
  upsertQoderAccount,
} from '../../src/server/db/repositories/qoder-accounts';

// Frozen so `jobTokenExpiresAt` assertions are not racing the clock.
const JOB_TOKEN_EXPIRES_AT = '2026-09-17T00:00:00.000Z';

const record = (
  overrides: Partial<{ token: string; userId: string; email: string | null; label: string | null; jobToken: string; expiresAt: string; machineId: string }> = {},
) => ({
  index: 0,
  personalToken: overrides.token ?? 'pt-first',
  jobToken: overrides.jobToken ?? 'jt-first',
  jobTokenExpiresAt: overrides.expiresAt ?? JOB_TOKEN_EXPIRES_AT,
  qoderUserId: overrides.userId ?? 'user-1',
  machineId: overrides.machineId ?? 'machine-1',
  email: overrides.email === undefined ? 'dev@example.com' : overrides.email,
  label: overrides.label === undefined ? 'Dev' : overrides.label,
  source: undefined,
});

const tempDirs: string[] = [];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-qoder-repo-'));
  tempDirs.push(dir);
  process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
  setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
  openDb(path.join(dir, 'data.sqlite'));
  getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('qp','Qoder','qoder','qoder','https://api2.qoder.sh')").run();
  getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('op','Other','other','openai','https://api.openai.com')").run();
});

afterEach(() => {
  closeDb();
  resetConfigForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Qoder account repository', () => {
  it('stores credentials as ciphertext and never returns them from a summary', () => {
    const id = insertQoderAccount('qp', record());
    const raw = JSON.stringify(getRawDb().prepare('SELECT * FROM qoder_accounts WHERE id=?').get(id));
    expect(raw).not.toContain('pt-first');
    expect(raw).not.toContain('jt-first');
    expect(getQoderCredentials(id)).toEqual({
      personalToken: 'pt-first',
      jobToken: 'jt-first',
      jobTokenExpiresAt: JOB_TOKEN_EXPIRES_AT,
    });
    expect(JSON.stringify(listQoderAccountSummaries('qp'))).not.toContain('pt-first');
    expect(listQoderAccountSummaries('qp')[0]!.qoderUserIdMasked).toBe('us…-1');
  });

  it('masks short and long values without leaking them whole', () => {
    expect(maskQoderValue(null)).toBeNull();
    expect(maskQoderValue('user-1')).toBe('us…-1');
    expect(maskQoderValue('user-1234567890')).toBe('user…7890');
    const summary = toQoderAccountSummary({
      id: 'x', label: null, email: null, qoderUserId: 'user-1234567890', machineId: 'm',
      enabled: 1, healthState: 'unknown', priority: 0, jobTokenExpiresAt: JOB_TOKEN_EXPIRES_AT,
      catalogFetchedAt: null, lastError: null, consecutiveFailures: 0, createdAt: 'a', updatedAt: 'b',
    });
    expect(summary.enabled).toBe(true);
    expect(summary.qoderUserIdMasked).toBe('user…7890');
    expect(summary).not.toHaveProperty('qoderUserId');
  });

  it('updates in place on re-add of the same qoder user and preserves identity', () => {
    insertQoderAccount('qp', record());
    const before = listQoderAccountSummaries('qp')[0]!;
    const result = upsertQoderAccount('qp', record({ token: 'pt-second', jobToken: 'jt-second', label: 'Dev 2' }));
    expect(result).toEqual({ id: before.id, status: 'updated' });
    const after = listQoderAccountSummaries('qp')[0]!;
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.priority).toBe(before.priority);
    expect(after.label).toBe('Dev 2');
    expect(getQoderCredentials(before.id).personalToken).toBe('pt-second');
    expect(listQoderAccountSummaries('qp')).toHaveLength(1);
  });

  it('adds a new account at the end of the priority order', () => {
    insertQoderAccount('qp', record());
    expect(upsertQoderAccount('qp', record({ userId: 'user-2', token: 'pt-b', jobToken: 'jt-b' })).status).toBe('inserted');
    const rows = listQoderAccountSummaries('qp');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.priority).toBe(rows[0]!.priority + 1);
  });

  it('selects only enabled, non-down accounts of the requested provider', () => {
    insertQoderAccount('qp', record());
    upsertQoderAccount('qp', record({ userId: 'user-2', token: 'pt-b', jobToken: 'jt-b' }));
    const [first, second] = listQoderAccountSummaries('qp');
    expect(findEligibleQoderAccount('op')).toBeNull();
    setQoderAccountHealth(first!.id, 'down', 'token rejected');
    expect(findEligibleQoderAccount('qp')?.id).toBe(second!.id);
    expect(listQoderAccountSummaries('qp')[0]!.lastError).toBe('token rejected');
    setQoderAccountHealth(second!.id, 'healthy', null);
    expect(findEligibleQoderAccount('qp')?.id).toBe(second!.id);
  });

  it('re-add resets health and failure state for a recovered account', () => {
    const id = insertQoderAccount('qp', record());
    setQoderAccountHealth(id, 'down', 'personal access token rejected — replace it');
    expect(listQoderAccountSummaries('qp')[0]!.healthState).toBe('down');
    upsertQoderAccount('qp', record({ token: 'pt-second', jobToken: 'jt-second' }));
    const after = listQoderAccountSummaries('qp')[0]!;
    expect(after.healthState).toBe('unknown');
    expect(after.lastError).toBeNull();
    expect(after.consecutiveFailures).toBe(0);
  });

  it('round-trips the cached catalog and job-token rotation', () => {
    const id = insertQoderAccount('qp', record());
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    persistQoderJobToken(id, { jobToken: 'jt-rotated', expiresAt, catalogJson: '{"entries":[]}', catalogFetchedAt: '2026-09-16T00:00:00.000Z' });
    expect(getQoderCredentials(id).jobToken).toBe('jt-rotated');
    expect(getQoderAccountRefreshState(id)).toEqual({ jobTokenExpiresAt: expiresAt });
    expect(readQoderCatalog(id)).toEqual({ catalogJson: '{"entries":[]}', catalogFetchedAt: '2026-09-16T00:00:00.000Z' });
    expect(listQoderAccountSummaries('qp')[0]!.healthState).toBe('healthy');
  });

  it('returns null state for an unknown account instead of throwing', () => {
    expect(getQoderAccountRefreshState('missing')).toBeNull();
    expect(readQoderCatalog('missing')).toBeNull();
    expect(() => getQoderCredentials('missing')).toThrow(/not found/i);
  });
});
