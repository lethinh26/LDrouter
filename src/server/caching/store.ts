// Gateway response cache: SQLite-backed exact-key cache.
// Disabled by default. Per-key/per-target controls. Stream-bypassed.

import { and, eq, sql, lt } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { sha256Hex } from '../auth/ids';
import { getSettings } from '../db/repositories/settings';
import { stableStringify } from '../util/stable-json';

export interface CacheKeyInput {
  protocol: 'openai' | 'anthropic';
  resolvedTargetKind: 'model' | 'combo' | 'alias';
  resolvedTargetId: string;
  configVersion: number;
  canonicalRequest: unknown; // object
}

export interface CacheLookup {
  hit: boolean;
  payload: unknown | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | null;
}

export function cacheAllowed(opts: {
  globalEnabled: boolean;
  keyAllowed: boolean | null;
  targetAllowed: boolean | null;
  streaming: boolean;
}): boolean {
  if (!opts.globalEnabled) return false;
  if (opts.streaming) return false;
  if (opts.keyAllowed === false) return false;
  if (opts.targetAllowed === false) return false;
  // Both unspecified or true => allowed
  return true;
}

export function buildCacheKey(input: CacheKeyInput): string {
  const material = JSON.stringify({
    p: input.protocol,
    k: input.resolvedTargetKind,
    id: input.resolvedTargetId,
    v: input.configVersion,
    r: stableStringify(input.canonicalRequest),
  });
  return sha256Hex(material);
}

export function lookupCache(cacheKey: string): CacheLookup {
  const db = getDb();
  const row = db.select().from(schema.responseCache).where(eq(schema.responseCache.cacheKey, cacheKey)).get();
  if (!row) return { hit: false, payload: null, usage: null };
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.delete(schema.responseCache).where(eq(schema.responseCache.id, row.id)).run();
    return { hit: false, payload: null, usage: null };
  }
  db.update(schema.responseCache)
    .set({ hitCount: row.hitCount + 1, lastHitAt: new Date().toISOString() })
    .where(eq(schema.responseCache.id, row.id))
    .run();
  let payload: unknown;
  try {
    payload = JSON.parse(row.responseJson);
  } catch {
    return { hit: false, payload: null, usage: null };
  }
  let usage: CacheLookup['usage'] = null;
  if (row.usageJson) {
    try {
      usage = JSON.parse(row.usageJson);
    } catch {
      usage = null;
    }
  }
  return { hit: true, payload, usage };
}

export function storeCache(input: {
  cacheKey: string;
  targetKind: 'model' | 'combo' | 'alias';
  targetId: string;
  configVersion: number;
  protocol: 'openai' | 'anthropic';
  payload: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | null;
  ttlSeconds: number;
}): void {
  const db = getDb();
  const responseJson = JSON.stringify(input.payload);
  const usageJson = input.usage ? JSON.stringify(input.usage) : null;
  const bytes = Buffer.byteLength(responseJson, 'utf8');
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
  // Enforce max size
  enforceSizeBudget();
  db.insert(schema.responseCache).values({
    id: crypto.randomUUID(),
    cacheKey: input.cacheKey,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetConfigVersion: input.configVersion,
    protocol: input.protocol,
    responseJson,
    usageJson,
    expiresAt,
    hitCount: 0,
    bytes,
  }).run();
}

export function invalidateCacheFor(kind: 'model' | 'combo' | 'alias', id: string): void {
  const db = getDb();
  db.delete(schema.responseCache).where(and(eq(schema.responseCache.targetKind, kind), eq(schema.responseCache.targetId, id))).run();
}

export function clearExpired(): number {
  const db = getDb();
  const r = db.delete(schema.responseCache).where(lt(schema.responseCache.expiresAt, new Date().toISOString())).run();
  return r.changes ?? 0;
}

export function clearAllCache(): number {
  const db = getDb();
  const r = db.delete(schema.responseCache).run();
  return r.changes ?? 0;
}

function enforceSizeBudget(): void {
  const s = getSettings();
  const db = getDb();
  const row = db.select({ total: sql<number>`COALESCE(SUM(bytes), 0)` }).from(schema.responseCache).get();
  const total = Number(row?.total ?? 0);
  const limit = s.gatewayCacheMaxSizeMb * 1024 * 1024;
  if (total < limit) return;
  // Evict oldest 10% by createdAt
  const tenPct = Math.max(1, Math.floor((db.select({ c: sql<number>`COUNT(*)` }).from(schema.responseCache).get()?.c ?? 1) * 0.1));
  const toEvict = db
    .select({ id: schema.responseCache.id })
    .from(schema.responseCache)
    .orderBy(schema.responseCache.createdAt)
    .limit(tenPct)
    .all();
  if (toEvict.length === 0) return;
  for (const e of toEvict) {
    db.delete(schema.responseCache).where(eq(schema.responseCache.id, e.id)).run();
  }
}

import crypto from 'node:crypto';
