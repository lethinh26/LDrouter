import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Ask C in the report: the quota snapshot has to be refreshed as an account is *used*, not only
 * when an admin presses a button. Before this, usage refreshed on the admin route and on the
 * 10-minute autostart tick (opted-in accounts only), so a dashboard could show hours-old
 * consumption for an account actively serving traffic.
 *
 * Both refreshes are second upstream calls, so they are throttled: a burst of requests must cost at
 * most one refresh per interval per account.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-usage-refresh-'));
const savedEnv = { dir: process.env.LATEDEV_DATA_DIR, key: process.env.LATEDEV_MASTER_KEY };

let codexId = '';
let qoderId = '';
let raw: ReturnType<typeof import('../../src/server/db').getRawDb>;

beforeAll(async () => {
  const { openDb, getRawDb } = await import('../../src/server/db');
  const { setConfigMasterKey } = await import('../../src/server/config');
  process.env.LATEDEV_DATA_DIR = dataDir;
  process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
  setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
  openDb(path.join(dataDir, 'data.sqlite'));
  raw = getRawDb();
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('cp','Codex','cp','codex','https://chatgpt.com')").run();
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('qp','Qoder','qp','qoder','https://api2.qoder.sh')").run();

  const codexRepo = await import('../../src/server/db/repositories/codex-accounts');
  const qoderRepo = await import('../../src/server/db/repositories/qoder-accounts');
  const { parseCodexImportText } = await import('../../src/server/providers/codex-import');
  const record = parseCodexImportText(JSON.stringify({
    access_token: 'access-token', refresh_token: 'refresh-token', email: 'usage@example.com',
    chatgpt_account_id: 'acct-usage', chatgpt_plan_type: 'plus',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }))[0] as never;
  codexId = codexRepo.insertCodexAccount('cp', record);
  qoderId = qoderRepo.insertQoderAccount('qp', {
    // Expiry in the future: an expired job token would trigger a PAT exchange first, and this test
    // is about the Credits call, not the credential seam.
    index: 0, personalToken: 'pt-x', jobToken: 'jt-x', jobTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    qoderUserId: 'u1', machineId: 'm1', email: null, label: null, source: undefined,
  });
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  (await import('../../src/server/db')).closeDb();
  (await import('../../src/server/config')).resetConfigForTests();
  if (savedEnv.key === undefined) delete process.env.LATEDEV_MASTER_KEY;
  else process.env.LATEDEV_MASTER_KEY = savedEnv.key;
  if (savedEnv.dir === undefined) delete process.env.LATEDEV_DATA_DIR;
  else process.env.LATEDEV_DATA_DIR = savedEnv.dir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Codex usage refresh on use', () => {
  it('refreshes a stale snapshot and records it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      plan_type: 'plus',
      rate_limit: { primary_window: { used_percent: 42, reset_at: Date.now() / 1000 + 3600 } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { refreshCodexUsageIfStale } = await import('../../src/server/providers/codex-autostart');
    await refreshCodexUsageIfStale(codexId);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('https://chatgpt.com/backend-api/wham/usage');
    const row = raw.prepare('SELECT codex_usage_json AS j, codex_usage_updated_at AS at FROM codex_accounts WHERE id=?').get(codexId) as { j: string | null; at: string | null };
    expect(row.at).toBeTruthy();
    expect(JSON.parse(row.j!).quotas.session.used).toBe(42);
  });

  it('leaves a fresh snapshot alone (throttled, not per-request)', async () => {
    // The previous test just wrote a fresh snapshot; a second call in the same interval must not
    // call upstream again, or every gateway request would double the upstream traffic.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ plan_type: 'plus', rate_limit: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { refreshCodexUsageIfStale } = await import('../../src/server/providers/codex-autostart');
    await refreshCodexUsageIfStale(codexId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes again once the snapshot is older than the interval', async () => {
    raw.prepare('UPDATE codex_accounts SET codex_usage_updated_at=? WHERE id=?').run(new Date(Date.now() - 6 * 60 * 1000).toISOString(), codexId);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      plan_type: 'plus', rate_limit: { primary_window: { used_percent: 77 } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { refreshCodexUsageIfStale } = await import('../../src/server/providers/codex-autostart');
    await refreshCodexUsageIfStale(codexId);
    expect(fetchMock).toHaveBeenCalled();
    const row = raw.prepare('SELECT codex_usage_json AS j FROM codex_accounts WHERE id=?').get(codexId) as { j: string | null };
    expect(JSON.parse(row.j!).quotas.session.used).toBe(77);
  });

  it('never throws when the usage API is unavailable', async () => {
    // A refresh is observability: it runs in the background after a successful response, so a
    // failure here must not surface anywhere near the client.
    raw.prepare('UPDATE codex_accounts SET codex_usage_updated_at=NULL WHERE id=?').run(codexId);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { refreshCodexUsageIfStale } = await import('../../src/server/providers/codex-autostart');
    await expect(refreshCodexUsageIfStale(codexId)).resolves.toBeUndefined();
  });
});

describe('Qoder credits refresh on use', () => {
  it('refreshes a stale snapshot and records it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      userType: 'personal_standard', totalUsagePercentage: 63, isQuotaExceeded: false,
      userQuota: { total: 1000, used: 630, remaining: 370, unit: 'credits' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { refreshQoderCreditsIfStale } = await import('../../src/server/providers/qoder/credits');
    await refreshQoderCreditsIfStale(qoderId);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('https://openapi.qoder.sh/api/v2/quota/usage');
    const row = raw.prepare('SELECT credits_json AS j, credits_updated_at AS at FROM qoder_accounts WHERE id=?').get(qoderId) as { j: string | null; at: string | null };
    expect(row.at).toBeTruthy();
    expect(JSON.parse(row.j!).totalUsedPercent).toBe(63);
  });

  it('leaves a fresh snapshot alone (throttled)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ isQuotaExceeded: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { refreshQoderCreditsIfStale } = await import('../../src/server/providers/qoder/credits');
    await refreshQoderCreditsIfStale(qoderId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the Credits API is unavailable', async () => {
    raw.prepare('UPDATE qoder_accounts SET credits_updated_at=NULL WHERE id=?').run(qoderId);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { refreshQoderCreditsIfStale } = await import('../../src/server/providers/qoder/credits');
    await expect(refreshQoderCreditsIfStale(qoderId)).resolves.toBeUndefined();
  });
});