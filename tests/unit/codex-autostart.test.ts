import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-autostart-'));
// Single-fork run shares process.env with every other test file, so env writes are saved and
// restored here — leaking LATEDEV_MASTER_KEY breaks master-key.test.ts, which requires it absent.
const savedEnv = { dir: process.env.LATEDEV_DATA_DIR, key: process.env.LATEDEV_MASTER_KEY };

let accountId = '';
let providerId = '';
let raw: ReturnType<typeof import('../../src/server/db').getRawDb>;

/** Seeds one enabled account whose 5h window is exhausted and already reset. */
function seed(resetAt: string, lastPingAt?: string) {
  raw.prepare('UPDATE codex_accounts SET codex_autostart_enabled=1, codex_usage_json=?, last_pinged_reset_key=NULL, last_ping_at=? WHERE id=?')
    .run(JSON.stringify({ plan: 'plus', limitReached: false, resetCredits: 0, fetchedAt: new Date().toISOString(), quotas: { session: { used: 100, total: 100, remaining: 0, resetAt } } }), lastPingAt ?? null, accountId);
}

beforeAll(async () => {
  const { openDb, getRawDb } = await import('../../src/server/db');
  const { setConfigMasterKey } = await import('../../src/server/config');
  process.env.LATEDEV_DATA_DIR = dataDir;
  process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
  setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
  openDb(path.join(dataDir, 'data.sqlite'));
  raw = getRawDb();
  const { insertCodexAccount } = await import('../../src/server/db/repositories/codex-accounts');
  providerId = 'codex-autostart-provider';
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES (?,'Codex','codex-autostart','codex','https://chatgpt.com')").run(providerId);
  const { parseCodexImportText } = await import('../../src/server/providers/codex-import');
  const record = parseCodexImportText(JSON.stringify({
    access_token: 'access-token', refresh_token: 'refresh-token', email: 'auto@example.com',
    chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus', expires_at: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  }))[0] as never;
  accountId = insertCodexAccount(providerId, record);
});

// restoreAllMocks does not un-stub stubGlobal; a leaked fetch stub breaks integration files
// that talk to a real test server.
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

describe('Codex 5h window auto-start', () => {
  const usageBody = (usedPercent: number) => JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: usedPercent, reset_at: Date.now() / 1000 - 60 } } });
  const okStream = () => new Response('data: {"type":"response.completed"}\n\n', { status: 200 });
  /** A fetch mock that answers usage reads and pings with fresh, single-use response bodies. */
  const mockFetch = (usedPercent = 100) => vi.fn().mockImplementation((url: unknown) =>
    String(url).includes('/wham/') ? Promise.resolve(new Response(usageBody(usedPercent), { status: 200 })) : Promise.resolve(okStream()));

  it('pings an exhausted account whose reset time has passed, then records the reset key', async () => {
    seed(new Date(Date.now() - 60_000).toISOString());
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { runCodexAutostartForAccount } = await import('../../src/server/providers/codex-autostart');
    await expect(runCodexAutostartForAccount(accountId)).resolves.toBe('pinged');
    const row = raw.prepare('SELECT last_pinged_reset_key AS k, last_ping_at AS p FROM codex_accounts WHERE id=?').get(accountId) as { k: string | null; p: string | null };
    expect(row.k).toBeTruthy();
    expect(row.p).toBeTruthy();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain('https://chatgpt.com/backend-api/codex/responses');
  });

  it('does not ping twice for the same reset minute', async () => {
    seed(new Date(Date.now() - 60_000).toISOString());
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { runCodexAutostartForAccount } = await import('../../src/server/providers/codex-autostart');
    await expect(runCodexAutostartForAccount(accountId)).resolves.toBe('pinged');
    const pingsAfterFirst = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/codex/responses')).length;
    await expect(runCodexAutostartForAccount(accountId)).resolves.toBe('skipped');
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/codex/responses')).length).toBe(pingsAfterFirst);
  });

  it('skips accounts that are not opted in', async () => {
    raw.prepare('UPDATE codex_accounts SET codex_autostart_enabled=0 WHERE id=?').run(accountId);
    const { runCodexAutostartForAccount } = await import('../../src/server/providers/codex-autostart');
    await expect(runCodexAutostartForAccount(accountId)).resolves.toBe('skipped');
    raw.prepare('UPDATE codex_accounts SET codex_autostart_enabled=1 WHERE id=?').run(accountId);
  });

  it('skips when the 5h window still has quota left', async () => {
    raw.prepare('UPDATE codex_accounts SET last_ping_at=NULL, last_pinged_reset_key=NULL WHERE id=?').run(accountId);
    const fetchMock = mockFetch(10);
    vi.stubGlobal('fetch', fetchMock);
    const { runCodexAutostartForAccount } = await import('../../src/server/providers/codex-autostart');
    await expect(runCodexAutostartForAccount(accountId)).resolves.toBe('skipped');
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).endsWith('/codex/responses'))).toBe(true);
  });

  it('records a sanitized usage error when the usage API fails, without clearing the account', async () => {
    raw.prepare('UPDATE codex_accounts SET last_ping_at=NULL, last_pinged_reset_key=NULL WHERE id=?').run(accountId);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const { runCodexAutostartForAccount } = await import('../../src/server/providers/codex-autostart');
    await expect(runCodexAutostartForAccount(accountId)).resolves.toBe('failed');
    const row = raw.prepare('SELECT codex_usage_error AS e, enabled FROM codex_accounts WHERE id=?').get(accountId) as { e: string | null; enabled: number };
    expect(row.e).toContain('HTTP 500');
    expect(row.enabled).toBe(1);
  });
});
