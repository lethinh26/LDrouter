// Gateway API-key authentication: extract credential, hash, compare.

import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { sha256Hex } from './ids';
import { GatewayError } from '../errors';
import type { FastifyRequest } from 'fastify';
import { resolveClientIp } from '../util/client-ip';
import { parseCidr } from '../util/cidr';
import type { ResolvedTarget } from '../routing/resolver';

export interface AuthenticatedKey {
  id: string;
  name: string;
  keyPrefix: string;
  allowAllModels: boolean;
  enabled: boolean;
  expiresAt: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  totalTokenLimit: number | null;
  maxConcurrent: number | null;
  maxOutputTokensPerRequest: number | null;
  cacheOverrideEnabled: boolean | null;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

export function extractAnthropicKey(headers: Record<string, string | string[] | undefined>): string | null {
  const v = headers['x-api-key'];
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

/**
 * Authenticate a gateway API key. Deterministic precedence:
 * 1. Authorization: Bearer (OpenAI-style)
 * 2. x-api-key (Anthropic-style)
 * Returns null when no credential is present (caller decides 401 vs anonymous).
 */
export function authenticateGatewayKey(req: { headers: Record<string, string | string[] | undefined> }): AuthenticatedKey | null {
  const bearer = extractBearerToken(Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : (req.headers.authorization as string | undefined));
  const anthropic = extractAnthropicKey(req.headers);
  let candidate: string | null = null;
  if (bearer && anthropic && bearer !== anthropic) {
    throw new GatewayError('authentication_error', 'Conflicting credentials', { status: 401 });
  }
  if (bearer) candidate = bearer;
  else if (anthropic) candidate = anthropic;
  if (!candidate) return null;

  // Custom keys are stored verbatim (no prefix requirement); auto-generated
  // keys start with ld-, but authentication must accept any stored secret.
  const digest = sha256Hex(candidate);
  const db = getDb();
  const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyDigest, digest)).get();

  if (!row) {
    throw new GatewayError('authentication_error', 'Invalid API key', { status: 401 });
  }
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    allowAllModels: row.allowAllModels,
    enabled: row.enabled,
    expiresAt: row.expiresAt,
    rpmLimit: row.rpmLimit,
    tpmLimit: row.tpmLimit,
    dailyTokenLimit: row.dailyTokenLimit,
    monthlyTokenLimit: row.monthlyTokenLimit,
    totalTokenLimit: row.totalTokenLimit,
    maxConcurrent: row.maxConcurrent,
    maxOutputTokensPerRequest: row.maxOutputTokensPerRequest,
    cacheOverrideEnabled: row.cacheOverrideEnabled,
  };
}

export function keyIsActive(key: { enabled: boolean; expiresAt: string | null }): boolean {
  return key.enabled && (key.expiresAt === null || Date.parse(key.expiresAt) > Date.now());
}

/** Deny wins; a configured allow list must match. Invalid stored rules fail closed. */
export function keyIpAllowed(keyId: string, clientIp: string): boolean {
  const rules = getDb().select().from(schema.apiKeyIpRules).where(eq(schema.apiKeyIpRules.apiKeyId, keyId)).all();
  let hasAllow = false;
  let allowMatch = false;
  try {
    for (const rule of rules) {
      const matches = parseCidr(rule.cidr).matches(clientIp);
      if (rule.mode === 'deny' && matches) return false;
      if (rule.mode === 'allow') { hasAllow = true; allowMatch ||= matches; }
    }
  } catch { return false; }
  return !hasAllow || allowMatch;
}

export function requireGatewayKey(req: FastifyRequest, credentialOnly?: 'x-api-key'): AuthenticatedKey {
  // The dedicated Codex route consumes the gateway key separately from the
  // caller's upstream Authorization. Other routes retain conflict detection.
  const key = credentialOnly ? authenticateGatewayKey({ headers: { 'x-api-key': req.headers['x-api-key'] } }) : authenticateGatewayKey(req);
  if (!key) throw new GatewayError('authentication_error', 'Missing API key', { status: 401 });
  if (!key.enabled) throw new GatewayError('authentication_error', 'API key disabled', { status: 401 });
  if (!keyIsActive(key)) throw new GatewayError('authentication_error', 'API key expired', { status: 401 });
  if (!keyIpAllowed(key.id, resolveClientIp(req))) throw new GatewayError('permission_error', 'IP address not permitted for this API key', { status: 403 });
  getDb().update(schema.apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(schema.apiKeys.id, key.id)).run();
  return key;
}

export function keyAllowedFor(key: AuthenticatedKey, targetKind: string, targetId: string): boolean {
  if (key.allowAllModels) return true;
  const db = getDb();
  const row = db
    .select()
    .from(schema.apiKeyModelPermissions)
    .where(sql`api_key_id = ${key.id} AND target_kind = ${targetKind} AND target_id = ${targetId}`)
    .get();
  return Boolean(row);
}

/** A directly allowed target remains reachable via its aliases. An alias-only
 * grant does not grant direct access to the underlying model or combo. */
export function keyAllowedForTarget(key: AuthenticatedKey, target: ResolvedTarget): boolean {
  if (target.kind === 'alias') return keyAllowedFor(key, 'alias', target.aliasId) || keyAllowedForTarget(key, target.resolved);
  return keyAllowedFor(key, target.kind, target.kind === 'model' ? target.modelId : target.comboId);
}
