// Retention cleanup: chunked deletion of old request logs.
// Audit logs are NEVER deleted here.

import { lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { getSettings } from '../db/repositories/settings';
import fs from 'node:fs';
import path from 'node:path';

export interface DailyRequestHistoryCleanupResult {
  deletedRequests: number;
  deletedAttempts: number;
  beforeDay: string;
}

export interface RetentionResult {
  deletedRequests: number;
  deletedAttempts: number;
  dryRun: boolean;
  cutoff: string;
}

const BATCH_SIZE = 1000;

function countRequestsOlderThan(cutoff: string): { requests: number; attempts: number } {
  const db = getDb();
  const rq = db.select({ c: sql<number>`COUNT(*)` }).from(schema.requests).where(lt(schema.requests.createdAt, cutoff)).get();
  const at = db.select({ c: sql<number>`COUNT(*)` }).from(schema.requestAttempts)
    .where(sql`${schema.requestAttempts.requestId} IN (SELECT ${schema.requests.id} FROM ${schema.requests} WHERE ${schema.requests.createdAt} < ${cutoff})`).get();
  return { requests: Number(rq?.c ?? 0), attempts: Number(at?.c ?? 0) };
}

export function runRetentionCleanup(now: Date = new Date(), opts: { dryRun?: boolean } = {}): RetentionResult {
  const s = getSettings();
  const cutoff = new Date(now.getTime() - s.retentionDays * 24 * 3600 * 1000).toISOString();
  const db = getDb();
  let deletedRequests = 0;
  if (opts.dryRun) {
    const counts = countRequestsOlderThan(cutoff);
    return { deletedRequests: counts.requests, deletedAttempts: counts.attempts, dryRun: true, cutoff };
  }
  // Attempts are cascade-deleted with their requests; count once up front.
  const deletedAttempts = countRequestsOlderThan(cutoff).attempts;
  // Cascade delete attempts
  while (true) {
    const rows = db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(lt(schema.requests.createdAt, cutoff))
      .limit(BATCH_SIZE)
      .all();
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const del = db.delete(schema.requests).where(sql`id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`).run();
    deletedRequests += del.changes ?? 0;
    if (rows.length < BATCH_SIZE) break;
  }
  return { deletedRequests, deletedAttempts, dryRun: false, cutoff };
}

/** Delete complete UTC days of request detail while preserving daily aggregates. */
export function runDailyRequestHistoryCleanup(now: Date = new Date()): DailyRequestHistoryCleanupResult {
  const beforeDay = now.toISOString().slice(0, 10);
  const db = getDb();
  let deletedRequests = 0;
  let deletedAttempts = 0;

  while (true) {
    const rows = db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(sql`substr(${schema.requests.createdAt}, 1, 10) < ${beforeDay}`)
      .limit(BATCH_SIZE)
      .all();
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    deletedAttempts += db.delete(schema.requestAttempts).where(sql`${schema.requestAttempts.requestId} IN (${idList})`).run().changes ?? 0;
    deletedRequests += db.delete(schema.requests).where(sql`${schema.requests.id} IN (${idList})`).run().changes ?? 0;
    if (rows.length < BATCH_SIZE) break;
  }
  return { deletedRequests, deletedAttempts, beforeDay };
}

export function applyDbSizeGuard(dataDir: string): { triggered: boolean; before: number; after: number } {
  const s = getSettings();
  const dbFile = path.join(dataDir, 'data.sqlite');
  const walFile = path.join(dataDir, 'data.sqlite-wal');
  const before = (fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0) + (fs.existsSync(walFile) ? fs.statSync(walFile).size : 0);
  const limitBytes = s.dbSizeLimitMb * 1024 * 1024;
  if (before <= limitBytes) return { triggered: false, before, after: before };
  const result = runRetentionCleanup();
  const after = (fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0) + (fs.existsSync(walFile) ? fs.statSync(walFile).size : 0);
  return { triggered: result.deletedRequests > 0, before, after };
}
