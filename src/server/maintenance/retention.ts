// Retention cleanup: chunked deletion of old request logs.
// Audit logs are NEVER deleted here.

import { lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { getSettings } from '../db/repositories/settings';
import fs from 'node:fs';
import path from 'node:path';

export interface RetentionResult {
  deletedRequests: number;
  deletedAttempts: number;
  dryRun: boolean;
  cutoff: string;
}

const BATCH_SIZE = 1000;

export function runRetentionCleanup(now: Date = new Date(), opts: { dryRun?: boolean } = {}): RetentionResult {
  const s = getSettings();
  const cutoff = new Date(now.getTime() - s.retentionDays * 24 * 3600 * 1000).toISOString();
  const db = getDb();
  let deletedAttempts = 0;
  let deletedRequests = 0;
  if (opts.dryRun) {
    const row = db.select({ c: sql<number>`COUNT(*)` }).from(schema.requests).where(lt(schema.requests.createdAt, cutoff)).get();
    return { deletedRequests: Number(row?.c ?? 0), deletedAttempts: 0, dryRun: true, cutoff };
  }
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
