import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, getRawDb } from '../../src/server/db';
import { resetConfigForTests, setConfigMasterKey } from '../../src/server/config';
import { findCodexAccountForImport, getCodexCredentials, identityFromCodexRecord, listCodexAccountSummaries, setCodexAccountHealth, upsertCodexAccount } from '../../src/server/db/repositories/codex-accounts';

const record = (accessToken: string, workspaceId: string | null = 'workspace-1', email = 'user@example.com', chatgptAccountId: string | null = 'account-1', idToken: string | null = null) => ({
  index: 0, email, workspaceId, chatgptAccountId, planType: 'plus',
  expiresAt: '2026-10-01T00:00:00.000Z', accessToken, refreshToken: `refresh-${accessToken}`, idToken,
  identity: chatgptAccountId ? `account:${chatgptAccountId}` : `workspace:${workspaceId}`,
});

describe('Codex account repository', () => {
  let dir = '';
  afterEach(() => { closeDb(); resetConfigForTests(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('encrypts credentials, upserts deterministically, preserves identity, and lists safe summaries', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-account-'));
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    const dbPath = path.join(dir, 'data.sqlite');
    openDb(dbPath);
    const raw = getRawDb();
    raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('provider-1','Codex','codex','codex','https://example.test')").run();

    const first = upsertCodexAccount('provider-1', record('access-a'));
    const stored = raw.prepare('SELECT id,created_at,encrypted_access_token,access_token_nonce FROM codex_accounts WHERE id=?').get(first.id) as { id: string; created_at: string; encrypted_access_token: string; access_token_nonce: string };
    expect(stored.encrypted_access_token).not.toContain('access-a');
    expect(stored.access_token_nonce).toBeTruthy();
    expect(getCodexCredentials(first.id)).toMatchObject({ accessToken: 'access-a', refreshToken: 'refresh-access-a' });

    const second = upsertCodexAccount('provider-1', record('access-b'));
    expect(second).toEqual({ id: first.id, status: 'updated' });
    expect(raw.prepare('SELECT id,created_at FROM codex_accounts WHERE id=?').get(first.id)).toEqual({ id: first.id, created_at: stored.created_at });
    expect(getCodexCredentials(first.id).accessToken).toBe('access-b');
    const summary = listCodexAccountSummaries('provider-1');
    expect(summary).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toContain('access-b');
  });

  it('re-imports the same workspace with a changed email and preserves identity', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-account-'));
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('provider-1','Codex','codex','codex','https://example.test')").run();
    const first = upsertCodexAccount('provider-1', record('workspace-token-a', 'workspace-stable', 'old@example.com', null));
    const created = getRawDb().prepare('SELECT created_at,updated_at FROM codex_accounts WHERE id=?').get(first.id) as { created_at: string; updated_at: string };
    const second = upsertCodexAccount('provider-1', record('workspace-token-b', 'workspace-stable', 'new@example.com', null, 'id-token'));
    const row = getRawDb().prepare('SELECT id,email,created_at,updated_at FROM codex_accounts WHERE id=?').get(first.id) as { id: string; email: string; created_at: string; updated_at: string };
    expect(second).toEqual({ id: first.id, status: 'updated' });
    expect(row).toMatchObject({ id: first.id, email: 'new@example.com', created_at: created.created_at });
    expect(row.updated_at).not.toBe(created.updated_at);
    expect(getCodexCredentials(first.id)).toMatchObject({ accessToken: 'workspace-token-b', idToken: 'id-token' });
  });

  it('rolls back an import when persistence fails', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-account-'));
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('provider-1','Codex','codex','codex','https://example.test')").run();
    expect(() => upsertCodexAccount('provider-1', { ...record('rollback-token'), expiresAt: null as unknown as string })).toThrow();
    expect(getRawDb().prepare('SELECT COUNT(*) AS count FROM codex_accounts').get()).toEqual({ count: 0 });
  });

  it('updates health, error, enabled, and updated timestamp', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-account-'));
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('provider-1','Codex','codex','codex','https://example.test')").run();
    const account = upsertCodexAccount('provider-1', record('health-token'));
    const before = getRawDb().prepare('SELECT updated_at FROM codex_accounts WHERE id=?').get(account.id) as { updated_at: string };
    setCodexAccountHealth(account.id, 'down', 'provider unavailable', false);
    const row = getRawDb().prepare('SELECT health_state,last_error,enabled,updated_at FROM codex_accounts WHERE id=?').get(account.id) as { health_state: string; last_error: string; enabled: number; updated_at: string };
    expect(row).toMatchObject({ health_state: 'down', last_error: 'provider unavailable', enabled: 0 });
    expect(row.updated_at).not.toBe(before.updated_at);
  });

  it('resolves import identity by account, workspace, token, then refuses email-only merge', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-account-'));
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    const raw = getRawDb();
    raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('provider-1','Codex','codex','codex','https://example.test'), ('provider-2','Other','other','codex','https://other.test')").run();
    const workspace = upsertCodexAccount('provider-1', record('workspace-token', 'workspace-priority', 'workspace@example.com', null));
    const account = upsertCodexAccount('provider-1', record('account-token', 'workspace-other', 'account@example.com', 'account-priority'));
    expect(findCodexAccountForImport('provider-1', { chatgptAccountId: 'account-priority', workspaceId: 'workspace-priority', email: 'changed@example.com', tokenDigest: 'nope' })?.id).toBe(account.id);
    expect(findCodexAccountForImport('provider-1', { chatgptAccountId: null, workspaceId: 'workspace-priority', email: 'changed@example.com', tokenDigest: 'nope' })?.id).toBe(workspace.id);
    expect(findCodexAccountForImport('provider-1', { ...identityFromCodexRecord(record('workspace-token', 'workspace-priority')), chatgptAccountId: null, workspaceId: null, email: 'changed@example.com' })?.id).toBe(workspace.id);
    expect(findCodexAccountForImport('provider-1', { chatgptAccountId: null, workspaceId: null, email: 'unknown@example.com', tokenDigest: 'nope' })).toBeNull();
    expect(findCodexAccountForImport('provider-2', { chatgptAccountId: 'account-priority', workspaceId: 'workspace-priority', email: null, tokenDigest: 'nope' })).toBeNull();
  });

  it('does not merge email-only accounts with different workspace identity', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-account-'));
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    getRawDb().prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('provider-1','Codex','codex','codex','https://example.test')").run();
    const a = upsertCodexAccount('provider-1', record('a', 'workspace-a'));
    const b = upsertCodexAccount('provider-1', { ...record('b', 'workspace-b'), chatgptAccountId: null, identity: 'workspace:workspace-b' });
    expect(b.id).not.toBe(a.id);
  });
});
