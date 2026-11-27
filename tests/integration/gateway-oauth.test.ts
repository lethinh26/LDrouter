import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getRawDb, openDb } from '../../src/server/db/index';
import { requireAdminAuth, requireAdminCsrf } from '../../src/server/auth/middleware';
import { sha256Hex } from '../../src/server/auth/ids';
import { registerGatewayOAuthAdminRoutes, registerGatewayOAuthTokenRoutes } from '../../src/server/routes/gateway-oauth';
import { resolveGatewayOAuthAccess } from '../../src/server/auth/gateway-oauth';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldrouter-oauth-'));
const dbFile = path.join(dir, 'oauth.sqlite');
const origin = 'http://127.0.0.1:43127/callback';
const clientId = 'ldrouter-codex';
const verifier = 'V'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = 'oauth-fixture-state-123';
const cookieHeader = 'ld_session=fixture-admin-session';
const csrf = 'fixture-csrf';
const keyId = 'fixture-key';
const keyDigest = sha256Hex('ld-fixture-key');
const start = Date.UTC(2026, 0, 1);
const day = 86400000;
let now = start;
let app: FastifyInstance;

function authorization(patch: Record<string, unknown> = {}) {
  return { client_id: clientId, response_type: 'code', redirect_uri: origin, code_challenge: challenge,
    code_challenge_method: 'S256', state, apiKeyId: keyId, ...patch };
}
function authorize(patch: Record<string, unknown> = {}, headers = { cookie: cookieHeader, 'x-csrf-token': csrf }) {
  return app.inject({ method: 'POST', url: '/api/admin/gateway-oauth/authorize', headers, payload: authorization(patch) });
}
async function code() {
  const res = await authorize();
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toContain('no-store');
  const callback = new URL(res.json().redirectUrl);
  expect(callback.origin + callback.pathname).toBe(origin);
  expect(callback.searchParams.get('state')).toBe(state);
  expect(callback.searchParams.get('code')).toMatch(/^ldo-c-[A-Za-z0-9_-]{43}$/);
  return callback.searchParams.get('code')!;
}
function token(body: Record<string, string> | string, remoteAddress = '127.0.0.1') {
  return app.inject({ method: 'POST', url: '/api/oauth/token', remoteAddress, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: typeof body === 'string' ? body : new URLSearchParams(body).toString() });
}
const exchangeBody = (value: string, patch: Record<string, string> = {}) => ({ grant_type: 'authorization_code', client_id: clientId,
  redirect_uri: origin, code: value, code_verifier: verifier, ...patch });
const refreshBody = (value: string, patch: Record<string, string> = {}) => ({ grant_type: 'refresh_token', client_id: clientId, refresh_token: value, ...patch });
type Pair = { access_token: string; refresh_token: string; token_type: string; expires_in: number };
async function grant(): Promise<Pair> {
  const response = await token(exchangeBody(await code()));
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.headers.pragma).toBe('no-cache');
  const pair = response.json<Pair>();
  expect(pair).toMatchObject({ access_token: expect.stringMatching(/^ldo-a-[A-Za-z0-9_-]{43}$/), refresh_token: expect.stringMatching(/^ldo-r-[A-Za-z0-9_-]{43}$/), token_type: 'Bearer', expires_in: 900 });
  return pair;
}
async function grants() {
  const res = await app.inject({ method: 'GET', url: '/api/admin/gateway-oauth/grants', headers: { cookie: cookieHeader } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toContain('no-store');
  return res.json().grants as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  openDb(dbFile);
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(async scoped => {
    scoped.addHook('preHandler', requireAdminAuth);
    scoped.addHook('preHandler', async req => { if (req.method !== 'GET') await requireAdminCsrf(req); });
    await registerGatewayOAuthAdminRoutes(scoped);
  });
  await registerGatewayOAuthTokenRoutes(app);
  // A sibling JSON route proves the form parser is encapsulated.
  app.post('/fixture-json', async req => req.body);
  await app.ready();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
beforeEach(() => {
  now = start;
  const raw = getRawDb();
  raw.exec('DELETE FROM audit_logs; DELETE FROM csrf_tokens; DELETE FROM admin_sessions; DELETE FROM admin_account; DELETE FROM api_keys;');
  raw.prepare('INSERT INTO admin_account(id,username,password_hash) VALUES (?,?,?)').run('fixture-admin', 'admin', 'fixture-password-hash');
  raw.prepare('INSERT INTO admin_sessions(id,token_digest,expires_at) VALUES (?,?,?)').run('session', sha256Hex('fixture-admin-session'), new Date(start + day).toISOString());
  raw.prepare('INSERT INTO csrf_tokens(id,session_id,token,expires_at) VALUES (?,?,?,?)').run('csrf', 'session', csrf, new Date(start + day).toISOString());
  raw.prepare('INSERT INTO api_keys(id,name,key_prefix,key_digest,enabled) VALUES (?,?,?,?,1)').run(keyId, 'Fixture gateway key', 'ld-fixture', keyDigest);
});
afterAll(async () => { vi.restoreAllMocks(); await app?.close(); closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('first-party gateway OAuth issuance and rotation', () => {
  it('uses actual admin authentication and CSRF and a fixed client/redirect/PKCE contract', async () => {
    expect((await authorize({}, {} as never)).statusCode).toBe(401);
    expect((await authorize({}, { cookie: cookieHeader } as never)).statusCode).toBe(403);
    for (const patch of [{ client_id: 'other' }, { response_type: 'token' }, { redirect_uri: origin + '/' }, { redirect_uri: 'http://localhost:43127/callback' },
      { code_challenge_method: 'plain' }, { code_challenge: 'x'.repeat(43) }, { code_challenge: 'x'.repeat(42) }, { state: 'short' }, { state: 'x'.repeat(513) }, { state: 'invalid state value' }, { state: state + '\n' }, { unexpected: 'field' }]) {
      const res = await authorize(patch);
      expect(res.statusCode).toBe(400);
      expect(res.headers['cache-control']).toContain('no-store');
    }
    expect(getRawDb().prepare('SELECT count(*) AS n FROM gateway_oauth_codes').get()).toEqual({ n: 0 });
  });

  it('stores only digests, binds code to PKCE and consumes it once', async () => {
    const value = await code();
    const raw = getRawDb();
    expect(raw.prepare('SELECT code_digest,key_id,key_digest,challenge,redirect_uri,session_id FROM gateway_oauth_codes').get()).toEqual({ code_digest: sha256Hex(value), key_id: keyId, key_digest: keyDigest, challenge, redirect_uri: origin, session_id: 'session' });
    expect((await token(exchangeBody(value, { code_verifier: 'Z'.repeat(43) }))).json()).toEqual({ error: 'invalid_grant' });
    expect((await token(exchangeBody(value, { code_verifier: verifier + '\n' }))).json()).toEqual({ error: 'invalid_request' });
    expect((await token(exchangeBody(value, { redirect_uri: origin + '?extra=1' }))).statusCode).toBe(400);
    const response = await token(exchangeBody(value));
    expect(response.statusCode).toBe(200);
    const pair = response.json<Pair>();
    expect(raw.prepare('SELECT count(*) AS n FROM gateway_oauth_codes').get()).toEqual({ n: 0 });
    const row = raw.prepare('SELECT * FROM gateway_oauth_grants').get() as Record<string, unknown>;
    expect(row).toMatchObject({ key_id: keyId, key_digest: keyDigest, access_digest: sha256Hex(pair.access_token), refresh_digest: sha256Hex(pair.refresh_token), created_at_ms: start,
      access_expires_at_ms: start + 900000, refresh_expires_at_ms: start + 30 * day, absolute_expires_at_ms: start + 90 * day, revoked_at_ms: null });
    expect(JSON.stringify(row)).not.toContain(pair.access_token);
    expect(JSON.stringify(row)).not.toContain(pair.refresh_token);
    expect(resolveGatewayOAuthAccess(pair.access_token)).toEqual({ keyId, keyDigest, grantId: row.id });
    for (const invalid of [pair.refresh_token, value, 'ldo-a-bad', 'ld-fixture-key']) expect(resolveGatewayOAuthAccess(invalid)).toBeNull();
    expect((await token(exchangeBody(value))).json()).toEqual({ error: 'invalid_grant' });
  });

  it.each(['expired code', 'deleted session', 'expired session', 'disabled key', 'expired key', 'changed digest', 'denied IP'] as const)('rejects exchange after %s', async kind => {
    const value = await code();
    const raw = getRawDb();
    switch (kind) {
      case 'expired code': now += 300001; break;
      case 'deleted session': raw.exec('DELETE FROM admin_sessions'); break;
      case 'expired session': raw.prepare('UPDATE admin_sessions SET expires_at=?').run(new Date(now).toISOString()); break;
      case 'disabled key': raw.exec('UPDATE api_keys SET enabled=0'); break;
      case 'expired key': raw.prepare('UPDATE api_keys SET expires_at=?').run(new Date(now).toISOString()); break;
      case 'changed digest': raw.prepare('UPDATE api_keys SET key_digest=?').run(sha256Hex('replacement')); break;
      case 'denied IP': raw.prepare('INSERT INTO api_key_ip_rules(id,api_key_id,mode,cidr) VALUES (?,?,?,?)').run('deny', keyId, 'deny', '127.0.0.0/8'); break;
    }
    const res = await token(exchangeBody(value));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_grant' });
    expect(raw.prepare('SELECT count(*) AS n FROM gateway_oauth_grants').get()).toEqual({ n: 0 });
  });

  it('rotates both credentials and commits whole-family revocation on refresh replay', async () => {
    const first = await grant();
    const binding = resolveGatewayOAuthAccess(first.access_token)!;
    now += 1000;
    const res = await token(refreshBody(first.refresh_token));
    expect(res.statusCode).toBe(200);
    const next = res.json<Pair>();
    expect(next.access_token).not.toBe(first.access_token);
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(resolveGatewayOAuthAccess(first.access_token)).toBeNull();
    expect(resolveGatewayOAuthAccess(next.access_token)).toEqual(binding);
    expect(getRawDb().prepare('SELECT * FROM gateway_oauth_used_refresh').all()).toEqual([{ token_digest: sha256Hex(first.refresh_token), grant_id: binding.grantId }]);
    expect((await token(refreshBody(first.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
    expect(getRawDb().prepare('SELECT revoked_at_ms FROM gateway_oauth_grants WHERE id=?').get(binding.grantId)).toEqual({ revoked_at_ms: now });
    expect(resolveGatewayOAuthAccess(next.access_token)).toBeNull();
    expect((await token(refreshBody(next.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
    expect((await grants())[0]?.status).toBe('revoked');
    expect((await token(refreshBody(first.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
    const audit = getRawDb().prepare('SELECT action,success,target_type,target_id,actor,metadata_json FROM audit_logs ORDER BY rowid').all();
    expect(audit).toEqual([
      { action: 'gateway_oauth.authorize', success: 1, target_type: 'api_key', target_id: keyId, actor: 'admin', metadata_json: null },
      { action: 'gateway_oauth.grant.issue', success: 1, target_type: 'gateway_oauth_grant', target_id: binding.grantId, actor: 'gateway_oauth_client', metadata_json: null },
      { action: 'gateway_oauth.refresh_reuse', success: 0, target_type: 'gateway_oauth_grant', target_id: binding.grantId, actor: 'gateway_oauth_client', metadata_json: null },
    ]);
    const serialized = JSON.stringify(getRawDb().prepare('SELECT * FROM audit_logs').all());
    for (const secret of [first.access_token, first.refresh_token, next.access_token, next.refresh_token, state, verifier, keyDigest]) expect(serialized).not.toContain(secret);
  });

  it('keeps refresh idle and absolute lifetimes bounded, including the final access TTL', async () => {
    let pair = await grant();
    now += 900000;
    expect(resolveGatewayOAuthAccess(pair.access_token)).toBeNull();
    expect((await grants())[0]?.status).toBe('refresh_required');
    for (const offset of [29 * day, 58 * day, 87 * day, 90 * day - 10000]) {
      now = start + offset;
      const res = await token(refreshBody(pair.refresh_token));
      expect(res.statusCode).toBe(200);
      pair = res.json<Pair>();
    }
    expect(pair.expires_in).toBe(10);
    const row = getRawDb().prepare('SELECT access_expires_at_ms,refresh_expires_at_ms,absolute_expires_at_ms FROM gateway_oauth_grants').get();
    expect(row).toEqual({ access_expires_at_ms: start + 90 * day, refresh_expires_at_ms: start + 90 * day, absolute_expires_at_ms: start + 90 * day });
    now = start + 90 * day;
    expect(resolveGatewayOAuthAccess(pair.access_token)).toBeNull();
    expect((await token(refreshBody(pair.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
  });

  it.each(['disabled', 'expired', 'digest', 'IP', 'idle'] as const)('does not refresh a %s key/family', async kind => {
    const pair = await grant();
    const raw = getRawDb();
    switch (kind) {
      case 'disabled': raw.exec('UPDATE api_keys SET enabled=0'); break;
      case 'expired': raw.prepare('UPDATE api_keys SET expires_at=?').run(new Date(now).toISOString()); break;
      case 'digest': raw.prepare('UPDATE api_keys SET key_digest=?').run(sha256Hex('replacement')); break;
      case 'IP': raw.prepare('INSERT INTO api_key_ip_rules(id,api_key_id,mode,cidr) VALUES (?,?,?,?)').run('deny', keyId, 'deny', '127.0.0.0/8'); break;
      case 'idle': now += 30 * day; break;
    }
    expect((await token(refreshBody(pair.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
    if (kind !== 'IP') expect(resolveGatewayOAuthAccess(pair.access_token)).toBeNull();
    expect(raw.prepare('SELECT count(*) AS n FROM gateway_oauth_used_refresh').get()).toEqual({ n: 0 });
  });

  it('survives normal reopen but admin revoke immediately invalidates both credentials', async () => {
    const pair = await grant();
    const binding = resolveGatewayOAuthAccess(pair.access_token)!;
    closeDb(); openDb(dbFile);
    expect(resolveGatewayOAuthAccess(pair.access_token)).toEqual(binding);
    const list = await grants();
    expect(list).toEqual([{ id: binding.grantId, apiKeyId: keyId, apiKeyName: 'Fixture gateway key', createdAt: new Date(start).toISOString(), accessExpiresAt: new Date(start + 900000).toISOString(), refreshExpiresAt: new Date(start + 30 * day).toISOString(), absoluteExpiresAt: new Date(start + 90 * day).toISOString(), lastRefreshedAt: null, status: 'active' }]);
    expect(JSON.stringify(list)).not.toContain(pair.access_token);
    const revoke = await app.inject({ method: 'DELETE', url: `/api/admin/gateway-oauth/grants/${binding.grantId}`, headers: { cookie: cookieHeader, 'x-csrf-token': csrf } });
    expect(revoke.statusCode).toBe(200);
    expect(resolveGatewayOAuthAccess(pair.access_token)).toBeNull();
    expect((await token(refreshBody(pair.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
    expect((await grants())[0]?.status).toBe('revoked');
    expect(getRawDb().prepare("SELECT action,success,target_id FROM audit_logs WHERE action='gateway_oauth.revoke'").all()).toEqual([{ action: 'gateway_oauth.revoke', success: 1, target_id: binding.grantId }]);
  });

  it('strictly parses unique form params with bounded size and no reflected input', async () => {
    const value = await code();
    const form = new URLSearchParams(exchangeBody(value)).toString();
    for (const invalid of [form + '&code=duplicate-secret', form + '&unknown=private-fixture', form + '&%63ode=duplicate-secret', form + '&x=%ZZ', form + '&', 'client_id=%FF']) {
      const res = await token(invalid);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.body).not.toContain('secret');
    }
    expect((await token('x=' + 'a'.repeat(8192))).statusCode).toBe(413);
    const wrongType = await app.inject({ method: 'POST', url: '/api/oauth/token', payload: exchangeBody(value) });
    expect(wrongType.statusCode).toBe(415);
    expect((await token(exchangeBody(value, { client_id: 'wrong' }))).json()).toEqual({ error: 'invalid_client' });
    expect((await token({ client_id: clientId, grant_type: 'client_credentials' })).json()).toEqual({ error: 'unsupported_grant_type' });
    expect((await app.inject({ method: 'POST', url: '/fixture-json', payload: { ok: true } })).json()).toEqual({ ok: true });
    expect((await token(exchangeBody(value))).statusCode).toBe(200);
  });

  it('enforces bounded pending-code issuance and expires old codes', async () => {
    for (let n = 0; n < 8; n++) await code();
    expect((await authorize()).statusCode).toBe(429);
    now += 300001;
    await code();
    expect(getRawDb().prepare('SELECT count(*) AS n FROM gateway_oauth_codes').get()).toEqual({ n: 1 });
  });

  it('exposes only consent metadata, including a hidden prefix for short custom keys', async () => {
    const raw = getRawDb();
    raw.prepare('INSERT INTO api_key_model_permissions(id,api_key_id,target_kind,target_id) VALUES (?,?,?,?)').run('permission', keyId, 'model', 'fixture-model');
    raw.prepare('INSERT INTO api_keys(id,name,key_prefix,key_digest,key_secret_encrypted,key_secret_nonce,tpm_limit) VALUES (?,?,?,?,?,?,?)')
      .run('short-key', 'Short custom key', 'shortsecret', sha256Hex('shortsecret'), 'fixture-ciphertext', 'fixture-nonce', 100);
    const url = '/api/admin/gateway-oauth/keys';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const keys = res.json().keys;
    expect(keys).toContainEqual({ id: keyId, name: 'Fixture gateway key', keyPrefix: 'ld-fixture', enabled: true, expiresAt: null, allowAllModels: false, modelCount: 1,
      tpmLimit: null, dailyTokenLimit: null, monthlyTokenLimit: null, totalTokenLimit: null, maxOutputTokensPerRequest: null });
    expect(keys).toContainEqual({ id: 'short-key', name: 'Short custom key', keyPrefix: '(hidden)', enabled: true, expiresAt: null, allowAllModels: false, modelCount: 0,
      tpmLimit: 100, dailyTokenLimit: null, monthlyTokenLimit: null, totalTokenLimit: null, maxOutputTokensPerRequest: null });
    for (const secret of ['shortsecret', 'fixture-ciphertext', 'fixture-nonce', keyDigest, sha256Hex('shortsecret')]) expect(res.body).not.toContain(secret);
    expect((await authorize({ apiKeyId: 'short-key' })).json().error.code).toBe('key_unavailable');
    raw.exec('UPDATE api_keys SET enabled=0 WHERE id=\'fixture-key\'');
    expect((await authorize()).json().error.code).toBe('key_unavailable');
  });

  it('rejects keys capped after authorization or grant issuance', async () => {
    const raw = getRawDb();
    const value = await code();
    raw.exec('UPDATE api_keys SET tpm_limit=100');
    expect((await token(exchangeBody(value))).json()).toEqual({ error: 'invalid_grant' });
    raw.exec('UPDATE api_keys SET tpm_limit=NULL');
    const pair = await grant();
    raw.exec('UPDATE api_keys SET max_output_tokens_per_request=100');
    expect((await token(refreshBody(pair.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
    expect(resolveGatewayOAuthAccess(pair.access_token)).toBeNull();
    expect((await grants())[0]?.status).toBe('key_unavailable');
  });

  it('requires secure transport except a loopback HTTP host and client', async () => {
    const value = await code();
    const form = new URLSearchParams(exchangeBody(value)).toString();
    for (const [host, remoteAddress] of [['example.test', '127.0.0.1'], ['127.0.0.1:8787', '192.0.2.10']]) {
      const denied = await app.inject({ method: 'POST', url: '/api/oauth/token', headers: { host, 'content-type': 'application/x-www-form-urlencoded' }, remoteAddress, payload: form });
      expect(denied.json()).toEqual({ error: 'invalid_request' });
      expect(denied.headers['cache-control']).toContain('no-store');
    }
    const denied = await app.inject({ method: 'POST', url: '/api/admin/gateway-oauth/authorize', headers: { host: 'example.test', cookie: cookieHeader, 'x-csrf-token': csrf }, payload: authorization() });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe('secure_transport_required');
    expect((await token(exchangeBody(value))).statusCode).toBe(200);
  });

  it('caps active grants per key without consuming an exchange blocked by capacity', async () => {
    let first: Pair | undefined;
    for (let n = 0; n < 16; n++) { const issued = await grant(); first ??= issued; }
    const value = await code();
    expect((await token(exchangeBody(value))).statusCode).toBe(429);
    const id = resolveGatewayOAuthAccess(first!.access_token)!.grantId;
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/gateway-oauth/grants/' + id, headers: { cookie: cookieHeader } })).statusCode).toBe(403);
    expect(resolveGatewayOAuthAccess(first!.access_token)).not.toBeNull();
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/gateway-oauth/grants/' + id, headers: { cookie: cookieHeader, 'x-csrf-token': csrf } })).statusCode).toBe(200);
    expect((await token(exchangeBody(value))).statusCode).toBe(200);
  });

  it('bounds spent refresh history without forgetting a single spent digest', async () => {
    const pair = await grant();
    const id = resolveGatewayOAuthAccess(pair.access_token)!.grantId;
    const raw = getRawDb();
    raw.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
      INSERT INTO gateway_oauth_used_refresh(token_digest,grant_id) SELECT printf('%064x',i),? FROM n`).run(id);
    expect((await token(refreshBody(pair.refresh_token))).statusCode).toBe(429);
    expect(raw.prepare('SELECT count(*) AS n FROM gateway_oauth_used_refresh').get()).toEqual({ n: 20000 });
    expect(resolveGatewayOAuthAccess(pair.access_token)).not.toBeNull();
    // At the absolute bound the family and all its tombstones expire together.
    now = start + 90 * day;
    expect((await token(refreshBody(pair.refresh_token))).json()).toEqual({ error: 'invalid_grant' });
    expect(raw.prepare('SELECT count(*) AS n FROM gateway_oauth_used_refresh').get()).toEqual({ n: 0 });
  });

  it('permits only one simultaneous code redemption and revokes a raced refresh family', async () => {
    const value = await code();
    const exchanged = await Promise.all([token(exchangeBody(value)), token(exchangeBody(value))]);
    expect(exchanged.map(r => r.statusCode).sort()).toEqual([200, 400]);
    const pair = exchanged.find(r => r.statusCode === 200)!.json<Pair>();
    const rotated = await Promise.all([token(refreshBody(pair.refresh_token)), token(refreshBody(pair.refresh_token))]);
    expect(rotated.map(r => r.statusCode).sort()).toEqual([200, 400]);
    expect(resolveGatewayOAuthAccess(rotated.find(r => r.statusCode === 200)!.json<Pair>().access_token)).toBeNull();
  });
});
