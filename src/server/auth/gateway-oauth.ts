// First-party LDrouter authorization only. No provider credentials, upstream
// authentication requests or client-owned account tokens enter this service.
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { getRawDb } from '../db/index';
import { parseCidr } from '../util/cidr';
import { resolveClientIp } from '../util/client-ip';
import { sha256Hex, uuid } from './ids';
import { hasCodexTokenCap } from '../gateway/codex';

export const GATEWAY_OAUTH_CLIENT_ID = 'ldrouter-codex';
export const GATEWAY_OAUTH_REDIRECT_URI = 'http://127.0.0.1:43127/callback';
const CODE_TTL = 5 * 60_000;
const ACCESS_TTL = 15 * 60_000;
const REFRESH_TTL = 30 * 86_400_000;
const ABSOLUTE_TTL = 90 * 86_400_000;
const MAX_CODES = 1024;
const MAX_CODES_PER_KEY = 8;
const MAX_CODES_PER_SESSION = 32;
const MAX_GRANTS = 2048;
const MAX_ACTIVE_GRANTS_PER_KEY = 16;
const MAX_ROTATIONS_PER_GRANT = 20_000;
const MAX_USED_REFRESH = 250_000;
const CLEANUP_CODES = 128;
const CLEANUP_GRANTS = 8;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i;
const LOOPBACK_V4 = parseCidr('127.0.0.0/8');
const LOOPBACK_V6 = parseCidr('::1/128');

/** Fastify's HTTPS protocol is trusted only under the application's existing
 * proxy configuration. Plain HTTP is restricted to loopback development. */
export function gatewayOAuthSecureTransport(req: FastifyRequest): boolean {
  const ip = resolveClientIp(req);
  if (!isIP(ip)) return false;
  if (req.protocol === 'https') return true;
  const peer = req.socket.remoteAddress ?? '';
  const loopback = (addr: string) => LOOPBACK_V4.matches(addr) || LOOPBACK_V6.matches(addr);
  return req.protocol === 'http' && LOOPBACK_HOST.test(req.headers.host ?? '') && loopback(ip) && loopback(peer);
}

export class GatewayOAuthError extends Error {
  constructor(readonly code: string, readonly status: number = 400) {
    // Only static, locally chosen error codes. Never embed submitted input.
    super(code);
    this.name = 'GatewayOAuthError';
  }
}

type RawDb = ReturnType<typeof getRawDb>;
type KeyRow = {
  id: string; name: string; keyPrefix: string; keyDigest: string;
  enabled: number; expiresAt: string | null; allowAllModels: number;
  tpmLimit: number | null; dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null; totalTokenLimit: number | null;
  maxOutputTokensPerRequest: number | null;
};
type CodeRow = {
  code_digest: string; key_id: string; key_digest: string; challenge: string;
  redirect_uri: string; session_id: string; expires_at_ms: number;
};
type GrantRow = {
  id: string; key_id: string; key_digest: string;
  access_digest: string; refresh_digest: string;
  access_expires_at_ms: number; refresh_expires_at_ms: number;
  absolute_expires_at_ms: number; created_at_ms: number;
  last_refreshed_at_ms: number | null; revoked_at_ms: number | null;
};
type TokenPair = { access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number };
type GrantStatus = 'active' | 'refresh_required' | 'expired' | 'revoked' | 'key_unavailable';
const keyColumns = 'id,name,key_prefix AS keyPrefix,key_digest AS keyDigest,enabled,expires_at AS expiresAt,allow_all_models AS allowAllModels,tpm_limit AS tpmLimit,daily_token_limit AS dailyTokenLimit,monthly_token_limit AS monthlyTokenLimit,total_token_limit AS totalTokenLimit,max_output_tokens_per_request AS maxOutputTokensPerRequest';

function keyFor(db: RawDb, id: string): KeyRow | undefined {
  return db.prepare('SELECT ' + keyColumns + ' FROM api_keys WHERE id=?').get(id) as KeyRow | undefined;
}

function availableKey(key: KeyRow | undefined, now: number, digest?: string): key is KeyRow {
  return !!key && key.enabled === 1 &&
    (key.expiresAt === null || Date.parse(key.expiresAt) > now) &&
    /^[a-f0-9]{64}$/.test(key.keyDigest) &&
    (digest === undefined || digest === key.keyDigest) && !hasCodexTokenCap(key);
}

function sessionActive(db: RawDb, id: string, now: number): boolean {
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE id=? AND EXISTS (SELECT 1 FROM admin_account)').get(id) as { expires_at: string } | undefined;
  return !!row && Date.parse(row.expires_at) > now;
}

function keyIpAllowed(db: RawDb, id: string, ip: string): boolean {
  if (!isIP(ip)) return false;
  const rules = db.prepare('SELECT mode,cidr FROM api_key_ip_rules WHERE api_key_id=?').all(id) as Array<{ mode: string; cidr: string }>;
  let hasAllow = false;
  let allowMatch = false;
  try {
    for (const rule of rules) {
      const matches = parseCidr(rule.cidr).matches(ip);
      if (rule.mode === 'deny' && matches) return false;
      if (rule.mode === 'allow') { hasAllow = true; allowMatch ||= matches; }
      else if (rule.mode !== 'deny') return false;
    }
  } catch { return false; }
  return !hasAllow || allowMatch;
}

function opaque(prefix: 'ldo-a-' | 'ldo-r-' | 'ldo-c-'): string {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

function canonical32(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function unreserved(value: unknown, min: number, max: number): value is string {
  // JS $ also matches before a final newline. Explicitly reject every
  // non-unreserved character rather than relying on an end anchor.
  return typeof value === 'string' && value.length >= min && value.length <= max && !/[^A-Za-z0-9._~-]/.test(value);
}

function tokenShape(value: unknown, prefix: 'ldo-a-' | 'ldo-r-' | 'ldo-c-'): value is string {
  return typeof value === 'string' && value.length === prefix.length + 43 && value.startsWith(prefix) && canonical32(value.slice(prefix.length));
}

function count(db: RawDb, sql: string, ...params: Array<string | number>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** Audit only actual state transitions, in the same transaction. The audit
 * schema receives no credential, digest, verifier, redirect or state value. */
function audit(db: RawDb, action: 'gateway_oauth.authorize' | 'gateway_oauth.grant.issue' | 'gateway_oauth.revoke' | 'gateway_oauth.refresh_reuse', targetType: 'api_key' | 'gateway_oauth_grant', targetId: string, ip: string): void {
  const admin = action === 'gateway_oauth.authorize' || action === 'gateway_oauth.revoke';
  db.prepare('INSERT INTO audit_logs(id,action,actor,ip,success,target_type,target_id) VALUES (?,?,?,?,?,?,?)')
    .run(uuid(), action, admin ? 'admin' : 'gateway_oauth_client', isIP(ip) ? ip : null, action === 'gateway_oauth.refresh_reuse' ? 0 : 1, targetType, targetId);
}

/** Bound work per request. Spent refresh digests remain with their family
 * until the absolute lifetime ends; no partial tombstone pruning. */
function cleanup(db: RawDb, now: number): void {
  db.prepare('DELETE FROM gateway_oauth_codes WHERE code_digest IN (SELECT code_digest FROM gateway_oauth_codes WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT ?)').run(now, CLEANUP_CODES);
  db.prepare('DELETE FROM gateway_oauth_grants WHERE id IN (SELECT id FROM gateway_oauth_grants WHERE absolute_expires_at_ms<=? ORDER BY absolute_expires_at_ms LIMIT ?)').run(now, CLEANUP_GRANTS);
}

function validateAuthorize(input: unknown): { apiKeyId: string; challenge: string; state: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GatewayOAuthError('invalid_request');
  const body = input as Record<string, unknown>;
  const fields = ['client_id', 'response_type', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'apiKeyId'];
  if (Object.keys(body).length !== fields.length || fields.some(f => !Object.hasOwn(body, f)) ||
      body.client_id !== GATEWAY_OAUTH_CLIENT_ID || body.response_type !== 'code' ||
      body.redirect_uri !== GATEWAY_OAUTH_REDIRECT_URI || body.code_challenge_method !== 'S256' ||
      typeof body.code_challenge !== 'string' || !canonical32(body.code_challenge) ||
      !unreserved(body.state, 16, 512) ||
      typeof body.apiKeyId !== 'string' || body.apiKeyId.length < 1 || body.apiKeyId.length > 128) {
    throw new GatewayOAuthError('invalid_request');
  }
  return { apiKeyId: body.apiKeyId, challenge: body.code_challenge, state: body.state };
}

export function authorizeGatewayOAuth(input: unknown, sessionId: string | undefined, ip: string): { redirectUrl: string } {
  const parsed = validateAuthorize(input);
  const db = getRawDb();
  const result = db.transaction(() => {
    const now = Date.now();
    if (!sessionId || !sessionActive(db, sessionId, now)) return { error: new GatewayOAuthError('invalid_session', 401) };
    const key = keyFor(db, parsed.apiKeyId);
    if (!availableKey(key, now)) return { error: new GatewayOAuthError('key_unavailable', 400) };
    cleanup(db, now);
    if (count(db, 'SELECT count(*) AS n FROM gateway_oauth_codes') >= MAX_CODES ||
        count(db, 'SELECT count(*) AS n FROM gateway_oauth_codes WHERE key_id=?', key.id) >= MAX_CODES_PER_KEY ||
        count(db, 'SELECT count(*) AS n FROM gateway_oauth_codes WHERE session_id=?', sessionId) >= MAX_CODES_PER_SESSION) {
      return { error: new GatewayOAuthError('temporarily_unavailable', 429) };
    }
    const code = opaque('ldo-c-');
    db.prepare('INSERT INTO gateway_oauth_codes(code_digest,key_id,key_digest,challenge,redirect_uri,session_id,expires_at_ms) VALUES (?,?,?,?,?,?,?)')
      .run(sha256Hex(code), key.id, key.keyDigest, parsed.challenge, GATEWAY_OAUTH_REDIRECT_URI, sessionId, now + CODE_TTL);
    audit(db, 'gateway_oauth.authorize', 'api_key', key.id, ip);
    const redirect = new URL(GATEWAY_OAUTH_REDIRECT_URI);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', parsed.state);
    return { redirectUrl: redirect.toString() };
  }).immediate();
  if ('error' in result && result.error) throw result.error;
  return { redirectUrl: result.redirectUrl! };
}

function pair(accessExpiry: number, now: number): TokenPair {
  return {
    access_token: opaque('ldo-a-'), refresh_token: opaque('ldo-r-'),
    token_type: 'Bearer', expires_in: Math.floor((accessExpiry - now) / 1000),
  };
}

function invalidGrant(): GatewayOAuthError { return new GatewayOAuthError('invalid_grant'); }

function exchangeCode(code: string, verifier: string, ip: string): TokenPair {
  const db = getRawDb();
  const result = db.transaction(() => {
    const now = Date.now();
    cleanup(db, now);
    const row = db.prepare('SELECT * FROM gateway_oauth_codes WHERE code_digest=?').get(sha256Hex(code)) as CodeRow | undefined;
    if (!row || row.expires_at_ms <= now || now < row.expires_at_ms - CODE_TTL ||
        row.redirect_uri !== GATEWAY_OAUTH_REDIRECT_URI || !sessionActive(db, row.session_id, now)) return { error: invalidGrant() };
    const actual = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (!canonical32(row.challenge) || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(row.challenge))) return { error: invalidGrant() };
    const key = keyFor(db, row.key_id);
    if (!availableKey(key, now, row.key_digest) || !keyIpAllowed(db, row.key_id, ip)) return { error: invalidGrant() };
    if (count(db, 'SELECT count(*) AS n FROM gateway_oauth_grants') >= MAX_GRANTS ||
        count(db, 'SELECT count(*) AS n FROM gateway_oauth_grants WHERE key_id=? AND key_digest=? AND revoked_at_ms IS NULL AND refresh_expires_at_ms>? AND absolute_expires_at_ms>?', key.id, key.keyDigest, now, now) >= MAX_ACTIVE_GRANTS_PER_KEY) {
      return { error: new GatewayOAuthError('temporarily_unavailable', 429) };
    }
    const tokens = pair(now + ACCESS_TTL, now);
    const id = uuid();
    db.prepare('INSERT INTO gateway_oauth_grants(id,key_id,key_digest,access_digest,refresh_digest,access_expires_at_ms,refresh_expires_at_ms,absolute_expires_at_ms,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, key.id, key.keyDigest, sha256Hex(tokens.access_token), sha256Hex(tokens.refresh_token), now + ACCESS_TTL, now + REFRESH_TTL, now + ABSOLUTE_TTL, now);
    db.prepare('DELETE FROM gateway_oauth_codes WHERE code_digest=?').run(row.code_digest);
    audit(db, 'gateway_oauth.grant.issue', 'gateway_oauth_grant', id, ip);
    return { tokens };
  }).immediate();
  if ('error' in result && result.error) throw result.error;
  return result.tokens!;
}

function grantLive(row: GrantRow, now: number): boolean {
  return row.revoked_at_ms === null && row.created_at_ms <= now &&
    (row.last_refreshed_at_ms === null || row.last_refreshed_at_ms <= now) &&
    row.refresh_expires_at_ms > now && row.absolute_expires_at_ms > now;
}

function rotateRefresh(token: string, ip: string): TokenPair {
  const db = getRawDb();
  const digest = sha256Hex(token);
  const result = db.transaction(() => {
    const now = Date.now();
    cleanup(db, now);
    const spent = db.prepare('SELECT grant_id FROM gateway_oauth_used_refresh WHERE token_digest=?').get(digest) as { grant_id: string } | undefined;
    if (spent) {
      // Returning instead of throwing inside the transaction is essential:
      // replay revokes the *current* access and refresh pair durably.
      const revoked = db.prepare('UPDATE gateway_oauth_grants SET revoked_at_ms=max(created_at_ms,?) WHERE id=? AND revoked_at_ms IS NULL').run(now, spent.grant_id).changes;
      if (revoked) audit(db, 'gateway_oauth.refresh_reuse', 'gateway_oauth_grant', spent.grant_id, ip);
      return { error: invalidGrant() };
    }
    const row = db.prepare('SELECT * FROM gateway_oauth_grants WHERE refresh_digest=?').get(digest) as GrantRow | undefined;
    if (!row || !grantLive(row, now) || !availableKey(keyFor(db, row.key_id), now, row.key_digest) ||
        !keyIpAllowed(db, row.key_id, ip)) return { error: invalidGrant() };
    if (count(db, 'SELECT count(*) AS n FROM gateway_oauth_used_refresh WHERE grant_id=?', row.id) >= MAX_ROTATIONS_PER_GRANT ||
        count(db, 'SELECT count(*) AS n FROM gateway_oauth_used_refresh') >= MAX_USED_REFRESH) {
      return { error: new GatewayOAuthError('temporarily_unavailable', 429) };
    }
    const refreshExpiry = Math.min(now + REFRESH_TTL, row.absolute_expires_at_ms);
    const accessExpiry = Math.min(now + ACCESS_TTL, refreshExpiry);
    if (accessExpiry - now < 1000) return { error: invalidGrant() };
    const tokens = pair(accessExpiry, now);
    db.prepare('INSERT INTO gateway_oauth_used_refresh(token_digest,grant_id) VALUES (?,?)').run(digest, row.id);
    db.prepare('UPDATE gateway_oauth_grants SET access_digest=?,refresh_digest=?,access_expires_at_ms=?,refresh_expires_at_ms=?,last_refreshed_at_ms=? WHERE id=?')
      .run(sha256Hex(tokens.access_token), sha256Hex(tokens.refresh_token), accessExpiry, refreshExpiry, now, row.id);
    return { tokens };
  }).immediate();
  if ('error' in result && result.error) throw result.error;
  return result.tokens!;
}

/** The HTTP parser supplies a strict unique parameter map. Require exactly
 * the fields appropriate for this public client and grant type. */
export function exchangeGatewayOAuthToken(params: ReadonlyMap<string, string>, ip: string): TokenPair {
  const allowed = new Set(['grant_type', 'client_id', 'code', 'code_verifier', 'redirect_uri', 'refresh_token']);
  if ([...params.keys()].some(k => !allowed.has(k)) || !params.has('grant_type') || !params.has('client_id')) {
    throw new GatewayOAuthError('invalid_request');
  }
  if (params.get('client_id') !== GATEWAY_OAUTH_CLIENT_ID) throw new GatewayOAuthError('invalid_client');
  const grantType = params.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = params.get('code');
    const verifier = params.get('code_verifier');
    if (params.size !== 5 || !code || !unreserved(verifier, 43, 128) ||
        params.get('redirect_uri') !== GATEWAY_OAUTH_REDIRECT_URI) throw new GatewayOAuthError('invalid_request');
    if (!tokenShape(code, 'ldo-c-')) throw invalidGrant();
    return exchangeCode(code, verifier, ip);
  }
  if (grantType === 'refresh_token') {
    const refresh = params.get('refresh_token');
    if (params.size !== 3 || !refresh) throw new GatewayOAuthError('invalid_request');
    if (!tokenShape(refresh, 'ldo-r-')) throw invalidGrant();
    return rotateRefresh(refresh, ip);
  }
  throw new GatewayOAuthError('unsupported_grant_type');
}

export function resolveGatewayOAuthAccess(token: string): { keyId: string; keyDigest: string; grantId: string } | null {
  if (!tokenShape(token, 'ldo-a-')) return null;
  const db = getRawDb();
  const row = db.prepare('SELECT * FROM gateway_oauth_grants WHERE access_digest=?').get(sha256Hex(token)) as GrantRow | undefined;
  const now = Date.now();
  if (!row || !grantLive(row, now) || row.access_expires_at_ms <= now ||
      !availableKey(keyFor(db, row.key_id), now, row.key_digest)) return null;
  return { keyId: row.key_id, keyDigest: row.key_digest, grantId: row.id };
}

/** No decrypted key, token, or digest is included in either consent endpoint.
 * Older/custom short keys may have their entire secret in key_prefix. */
export function listGatewayOAuthKeys() {
  const db = getRawDb();
  const keys = db.prepare('SELECT ' + keyColumns + ', (SELECT count(*) FROM api_key_model_permissions WHERE api_key_id=api_keys.id) AS modelCount FROM api_keys ORDER BY name,id').all() as Array<KeyRow & { modelCount: number }>;
  return keys.map(({ keyDigest, keyPrefix, enabled, allowAllModels, ...metadata }) => ({
    ...metadata, keyPrefix: sha256Hex(keyPrefix) === keyDigest ? '(hidden)' : keyPrefix,
    enabled: enabled === 1, allowAllModels: allowAllModels === 1,
  }));
}

export function listGatewayOAuthGrants() {
  const db = getRawDb();
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM gateway_oauth_grants ORDER BY created_at_ms DESC,id LIMIT ?').all(MAX_GRANTS) as GrantRow[];
  return rows.map(row => {
    const key = keyFor(db, row.key_id);
    const status: GrantStatus = row.revoked_at_ms !== null ? 'revoked' :
      !grantLive(row, now) ? 'expired' :
        !availableKey(key, now, row.key_digest) ? 'key_unavailable' :
          row.access_expires_at_ms <= now ? 'refresh_required' : 'active';
    return {
      id: row.id, apiKeyId: row.key_id, apiKeyName: key?.name ?? '',
      createdAt: new Date(row.created_at_ms).toISOString(), accessExpiresAt: new Date(row.access_expires_at_ms).toISOString(),
      refreshExpiresAt: new Date(row.refresh_expires_at_ms).toISOString(), absoluteExpiresAt: new Date(row.absolute_expires_at_ms).toISOString(),
      lastRefreshedAt: row.last_refreshed_at_ms === null ? null : new Date(row.last_refreshed_at_ms).toISOString(), status,
    };
  });
}

export function revokeGatewayOAuthGrant(id: string, ip: string): void {
  if (typeof id !== 'string' || id.length < 1 || id.length > 128) throw new GatewayOAuthError('invalid_request');
  const db = getRawDb();
  const found = db.transaction(() => {
    const row = db.prepare('SELECT revoked_at_ms FROM gateway_oauth_grants WHERE id=?').get(id) as { revoked_at_ms: number | null } | undefined;
    if (!row) return false;
    if (row.revoked_at_ms === null) {
      db.prepare('UPDATE gateway_oauth_grants SET revoked_at_ms=max(created_at_ms,?) WHERE id=?').run(Date.now(), id);
      audit(db, 'gateway_oauth.revoke', 'gateway_oauth_grant', id, ip);
    }
    return true;
  }).immediate();
  if (!found) throw new GatewayOAuthError('grant_not_found', 404);
}
