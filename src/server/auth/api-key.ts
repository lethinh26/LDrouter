// Gateway API-key authentication: extract credential, hash, compare.

import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { sha256Hex } from './ids';
void sha256Hex;
import { GatewayError } from '../errors';

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
    maxConcurrent: row.maxConcurrent,
    maxOutputTokensPerRequest: row.maxOutputTokensPerRequest,
    cacheOverrideEnabled: row.cacheOverrideEnabled,
  };
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
