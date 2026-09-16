import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getRawDb, openDb } from '../../src/server/db';
import { resetConfigForTests, setConfigMasterKey } from '../../src/server/config';
import { getCodexCredentials, upsertCodexAccount } from '../../src/server/db/repositories/codex-accounts';
import { configureCodexOAuthRefreshClient, needsCodexRefresh, refreshCodexAccount, withCodexCredentials } from '../../src/server/providers/codex-refresh';
import { CODEX_OAUTH } from '../../src/server/providers/codex-oauth';

const record = (expiresAt: string, idToken: string | null = 'old-id') => ({ index: 0, email: 'user@example.com', workspaceId: 'workspace-1', chatgptAccountId: 'account-1', planType: 'plus', expiresAt, accessToken: 'old-access', refreshToken: 'old-refresh', idToken, identity: 'account:account-1' });

function setup(expiresAt = '2026-09-12T01:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-refresh-'));
  tempDirs.push(dir);
  process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
  setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
  openDb(path.join(dir, 'data.sqlite'));
  getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('provider-1','Codex','codex','codex','https://example.test')").run();
  const id = upsertCodexAccount('provider-1', record(expiresAt)).id;
  return { dir, id };
}

const tempDirs: string[] = [];

describe('Codex refresh lifecycle', () => {
  afterEach(() => { configureCodexOAuthRefreshClient(null); closeDb(); resetConfigForTests(); for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('detects tokens inside the refresh lead time', () => {
    const account = { tokenExpiresAt: '2026-09-12T00:04:00.000Z' };
    expect(needsCodexRefresh(account, new Date('2026-09-12T00:00:00.000Z'))).toBe(true);
    expect(needsCodexRefresh({ tokenExpiresAt: '2026-09-12T01:00:00.000Z' }, new Date('2026-09-12T00:00:00.000Z'))).toBe(false);
  });

  it('sends client_id on the real refresh request, which the endpoint requires', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    // No injected client this time: exercise defaultRefreshClient, the path production uses.
    // Without client_id the endpoint answers 400 `Missing 'client_id'` and every expired token
    // stays unusable, which is what surfaced to operators as an opaque refresh failure.
    const fetchMock = vi.fn(async (_url: unknown, _init: { body: URLSearchParams }) => new Response(
      JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'));
    expect(result).toMatchObject({ ok: true });
    const body = fetchMock.mock.calls[0]?.[1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(body.get('client_id')).toBe(CODEX_OAUTH.clientId);
    vi.unstubAllGlobals();
  });

  it('persists rotated refresh tokens and preserves an omitted id token', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    configureCodexOAuthRefreshClient(async (input) => { expect(input.refreshToken).toBe('old-refresh'); return { accessToken: 'new-access', refreshToken: 'rotated-refresh', expiresIn: 3600 }; });
    const result = await refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'));
    expect(result).toMatchObject({ ok: true });
    expect(getCodexCredentials(id)).toEqual({ accessToken: 'new-access', refreshToken: 'rotated-refresh', idToken: 'old-id' });
  });

  it('fails safely and keeps old credentials when refresh fails', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    configureCodexOAuthRefreshClient(async () => { throw new Error('secret-old-refresh upstream refused'); });
    const result = await refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'));
    expect(result).toEqual({ ok: false, error: 'oauth_refresh_failed' });
    expect(getCodexCredentials(id).accessToken).toBe('old-access');
    expect((getRawDb().prepare('SELECT health_state,last_error FROM codex_accounts WHERE id=?').get(id) as { health_state: string; last_error: string }).health_state).toBe('degraded');
    expect(JSON.stringify(result)).not.toContain('old-refresh');
  });

  it('rejects malformed and expired refresh expiries without persisting', async () => {
    const cases = [
      { expiresAt: 'not-a-date' }, { expiresIn: undefined }, { expiresIn: 0 },
      { expiresIn: -1 }, { expiresIn: Number.NaN }, { expiresIn: Number.POSITIVE_INFINITY },
      { expiresAt: '2026-09-11T23:00:00.000Z' },
    ];
    for (const response of cases) {
      const { id } = setup('2026-09-12T00:01:00.000Z');
      configureCodexOAuthRefreshClient(async () => ({ accessToken: 'new-access', ...response }));
      await expect(refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'))).resolves.toEqual({ ok: false, error: 'invalid_refresh_response' });
      expect(getCodexCredentials(id).accessToken).toBe('old-access');
      closeDb(); resetConfigForTests(); fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('aborts a refresh using the configured timeout', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    configureCodexOAuthRefreshClient(async ({ signal }) => await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), 5);
    await expect(refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'))).resolves.toEqual({ ok: false, error: 'oauth_refresh_failed' });
  });

  it('cleans up a rejected single-flight and preserves a rotated id token', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    configureCodexOAuthRefreshClient(async () => { throw new Error('upstream'); });
    await expect(refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'))).resolves.toEqual({ ok: false, error: 'oauth_refresh_failed' });
    configureCodexOAuthRefreshClient(async () => ({ accessToken: 'new-access', expiresIn: 3600, idToken: 'rotated-id' }));
    await expect(refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'))).resolves.toMatchObject({ ok: true });
    expect(getCodexCredentials(id).idToken).toBe('rotated-id');
  });

  it('single-flights concurrent refreshes and retries one unauthorized call', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    let calls = 0;
    configureCodexOAuthRefreshClient(async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { accessToken: 'new-access', expiresIn: 3600 }; });
    const first = vi.fn(async () => { const error = Object.assign(new Error('unauthorized'), { status: 401 }); throw error; });
    const second = vi.fn(async () => 'ok');
    const refreshes = await Promise.all([
      refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z')),
      refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z')),
    ]);
    expect(refreshes[0]).toEqual(refreshes[1]);
    expect(calls).toBe(1);
    await expect(withCodexCredentials(id, first, new Date('2026-09-12T00:00:00.000Z'))).rejects.toMatchObject({ status: 401 });
    const value = await withCodexCredentials(id, second, new Date('2026-09-12T00:00:00.000Z'));
    expect(value).toBe('ok');
    expect(calls).toBe(2);
  });

  it('handles HTTP 403 with exactly one forced refresh and one retry boundary', async () => {
    const { id } = setup('2026-09-12T01:00:00.000Z');
    let refreshes = 0;
    const calls: string[] = [];
    configureCodexOAuthRefreshClient(async () => { refreshes += 1; return { accessToken: `access-${refreshes}`, expiresIn: 3600 }; });
    const fn = vi.fn(async (credentials) => {
      calls.push(credentials.accessToken);
      if (calls.length === 1) throw Object.assign(new Error('forbidden credential'), { status: 403 });
      return 'ok';
    });

    await expect(withCodexCredentials(id, fn, new Date('2026-09-12T00:00:00.000Z'))).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['old-access', 'access-1']);
    expect(refreshes).toBe(1);
  });

  it('rolls back every refresh field when the database write fails mid-transaction', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    const before = getRawDb().prepare('SELECT encrypted_access_token,encrypted_refresh_token,encrypted_id_token,token_expires_at,health_state,last_error FROM codex_accounts WHERE id=?').get(id) as Record<string, string | null>;
    getRawDb().prepare(`CREATE TRIGGER fail_codex_refresh BEFORE UPDATE OF encrypted_access_token ON codex_accounts BEGIN SELECT RAISE(ABORT, 'injected database failure'); END`).run();
    configureCodexOAuthRefreshClient(async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', idToken: 'new-id', expiresIn: 3600 }));

    await expect(refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'))).resolves.toEqual({ ok: false, error: 'oauth_refresh_failed' });
    const after = getRawDb().prepare('SELECT encrypted_access_token,encrypted_refresh_token,encrypted_id_token,token_expires_at,health_state,last_error FROM codex_accounts WHERE id=?').get(id);
    expect(after).toMatchObject({ ...before, health_state: 'degraded', last_error: 'oauth_refresh_failed' });
    expect(getCodexCredentials(id)).toEqual({ accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'old-id' });
  });

  it('sanitizes repository and decryption failures and degrades account health', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    getRawDb().prepare("UPDATE codex_accounts SET encrypted_refresh_token='not-a-secret-ciphertext' WHERE id=?").run(id);
    configureCodexOAuthRefreshClient(async ({ refreshToken }) => { throw new Error(`credential ${refreshToken}`); });

    const result = await refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'));
    expect(result).toEqual({ ok: false, error: 'oauth_refresh_failed' });
    expect(JSON.stringify(result)).not.toContain('not-a-secret-ciphertext');
    const health = getRawDb().prepare('SELECT health_state,last_error FROM codex_accounts WHERE id=?').get(id) as { health_state: string; last_error: string };
    expect(health).toEqual({ health_state: 'degraded', last_error: 'oauth_refresh_failed' });

    getRawDb().prepare('UPDATE codex_accounts SET encrypted_refresh_token=? WHERE id=?').run('still-secret-ciphertext', id);
    await expect(withCodexCredentials(id, async () => 'unreachable', new Date('2026-09-12T00:00:00.000Z'))).rejects.toThrow('credential_unavailable');
    expect(JSON.stringify(getRawDb().prepare('SELECT last_error FROM codex_accounts WHERE id=?').get(id))).not.toContain('still-secret-ciphertext');
  });

  it('sanitizes refresh-state repository failures', async () => {
    const { id } = setup('2026-09-12T00:01:00.000Z');
    getRawDb().prepare('DROP TABLE codex_accounts').run();
    await expect(refreshCodexAccount(id, new Date('2026-09-12T00:00:00.000Z'))).resolves.toEqual({ ok: false, error: 'oauth_refresh_failed' });
  });
});
