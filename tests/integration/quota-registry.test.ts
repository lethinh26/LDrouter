import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldrouter-quota-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
const endpoint = '/api/admin/subscription-quotas';
let app: FastifyInstance;
let cookie = '', csrf = '';
const observedAt = new Date(Date.now() - 1000).toISOString();
const window = { label: 'Five hours', usedPercent: 37.5, windowDurationMins: 300, resetsAt: null };
const manual = { source: 'manual', observedAt, plan: 'Pro', windows: [window] };
function mutate(method: 'POST' | 'PATCH' | 'DELETE', suffix: string, payload?: unknown) {
  return app.inject({ method, url: endpoint + suffix, headers: { cookie, 'x-csrf-token': csrf, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}
const list = () => app.inject({ method: 'GET', url: endpoint, headers: { cookie } });

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  const credentials = { username: 'admin', password: 'quota-fixture-password' };
  expect((await app.inject({ method: 'POST', url: '/api/admin/setup', payload: credentials })).statusCode).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: credentials });
  const header = login.headers['set-cookie'];
  cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0] ?? '';
  csrf = (await app.inject({ method: 'GET', url: '/api/admin/csrf', headers: { cookie } })).json().csrfToken;
});
afterAll(async () => {
  await app?.close();
  (await import('../../src/server/db/index')).closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('subscription quota observations', () => {
  it('requires admin auth and CSRF, isolates named accounts and rejects duplicates', async () => {
    expect((await app.inject({ method: 'GET', url: endpoint })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: endpoint, headers: { cookie }, payload: { providerKind: 'codex', name: 'Forbidden' } })).statusCode).toBe(403);
    expect((await list()).json()).toEqual({ accounts: [] });
    expect((await mutate('POST', '', { providerKind: 'codex', name: 'Personal', apiKey: 'forbidden' })).statusCode).toBe(400);
    const a = await mutate('POST', '', { providerKind: 'codex', name: 'Personal' });
    const b = await mutate('POST', '', { providerKind: 'claude_code', name: 'Personal' });
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect((await mutate('POST', '', { providerKind: 'codex', name: ' personal ' })).statusCode).toBe(409);
    const id = b.json().id;
    expect((await mutate('POST', '/' + id + '/snapshot', manual)).statusCode).toBe(200);
    const accounts = (await list()).json().accounts;
    expect(accounts.find((x: { id: string }) => x.id === id)).toMatchObject({ identityBound: false, snapshot: { ...manual, ordinaryUsageAllowed: null } });
    expect(accounts.find((x: { id: string }) => x.id === a.json().id).snapshot).toBeNull();
    expect((await mutate('POST', '/' + id + '/snapshot', { ...manual, windows: [{ ...window, usedPercent: 101 }] })).statusCode).toBe(400);
    expect((await mutate('POST', '/' + id + '/snapshot', { ...manual, observedAt: '2020-01-01T00:00:00Z' })).statusCode).toBe(409);
    expect((await mutate('POST', '/' + id + '/snapshot', { ...manual, observedAt: new Date(Date.now() + 3600000).toISOString() })).statusCode).toBe(400);
    expect((await mutate('PATCH', '/' + id, { name: 'Claude personal' })).statusCode).toBe(200);
    expect((await mutate('DELETE', '/' + id)).statusCode).toBe(200);
    expect((await list()).json().accounts).toHaveLength(1);
    const { getRawDb } = await import('../../src/server/db/index');
    expect(getRawDb().prepare('SELECT count(*) AS n FROM providers').get()).toEqual({ n: 0 });
    expect(getRawDb().prepare("SELECT count(*) AS n FROM audit_logs WHERE action='subscription_quota.delete' AND target_id=?").get(id)).toEqual({ n: 1 });
  });

  it('normalizes only quota metadata, prefers multiple buckets, binds identity and rejects cross-account imports', async () => {
    const a = (await list()).json().accounts[0].id;
    const b = (await mutate('POST', '', { providerKind: 'codex', name: 'Other account' })).json().id;
    const c = (await mutate('POST', '', { providerKind: 'claude_code', name: 'Claude subscription' })).json().id;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const primary = { usedPercent: 41, windowDurationMins: 300, resetsAt: reset };
    const result = {
      accountId: 'account-fixture-a', ordinaryUsageAllowed: false,
      rateLimits: { limitId: 'codex', primary, planType: 'plus' },
      rateLimitsByLimitId: {
        codex: { primary, secondary: { usedPercent: 67, windowDurationMins: 10080 }, planType: 'plus' },
        other: { primary: { usedPercent: 100 }, planType: 'plus' },
      },
      unknownMetadata: { accessToken: 'secret-fixture-not-to-persist' },
    };
    const payload = { source: 'codex_app_server', observedAt, result };
    expect((await mutate('POST', '/' + a + '/snapshot', payload)).statusCode).toBe(200);
    const loaded = (await list()).json().accounts.find((x: { id: string }) => x.id === a);
    expect(loaded).toMatchObject({ identityBound: true, snapshot: {
      source: 'codex_app_server', plan: 'plus', ordinaryUsageAllowed: false,
      windows: [
        { label: 'codex / primary', usedPercent: 41, windowDurationMins: 300, resetsAt: new Date(reset * 1000).toISOString() },
        { label: 'codex / secondary', usedPercent: 67, windowDurationMins: 10080, resetsAt: null },
        { label: 'other / primary', usedPercent: 100, windowDurationMins: null, resetsAt: null },
      ],
    } });
    expect((await mutate('POST', '/' + b + '/snapshot', payload)).statusCode).toBe(409);
    expect((await mutate('POST', '/' + a + '/snapshot', { ...payload, result: { ...result, accountId: 'account-fixture-b' } })).statusCode).toBe(409);
    expect((await mutate('POST', '/' + a + '/snapshot', { ...payload, result: { ...result, accountId: null } })).statusCode).toBe(409);
    expect((await mutate('POST', '/' + c + '/snapshot', payload)).statusCode).toBe(400);
    expect((await mutate('POST', '/' + a + '/snapshot', manual)).statusCode).toBe(200);
    const final = (await list()).json().accounts.find((x: { id: string }) => x.id === a);
    expect(final.identityBound).toBe(true);
    expect(final.snapshot.source).toBe('manual');
    const { getRawDb } = await import('../../src/server/db/index');
    const persisted = JSON.stringify(getRawDb().prepare('SELECT * FROM subscription_quota_accounts').all());
    expect(persisted).not.toContain('account-fixture-a');
    expect(persisted).not.toContain('secret-fixture-not-to-persist');
    expect(JSON.stringify((await list()).json())).not.toContain('account_fingerprint');
  });
});
