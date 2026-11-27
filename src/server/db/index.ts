// Database bootstrap: opens SQLite WAL, applies pending migrations, returns a Drizzle DB handle.

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { getLogger } from '../logging/logger';
import { CURRENT_SCHEMA_VERSION, runMigrations } from './migrate';
import { snapshotBeforeIntegrationRemoval } from './rollback-snapshot';
import { resetCircuits } from '../routing/circuit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Locate the migrations directory across the possible layouts:
 *  - Docker dist:          dist/server/db → ../../migrations   (dist/migrations)
 *  - npm package dist:     dist/server/db → ../../../migrations (<pkg>/migrations)
 *  - source tree (dev/test): src/server/db → ../../../migrations (repo/migrations)
 */
function resolveMigrationsDir(): string {
  const distDir = path.resolve(__dirname, '../../migrations');
  const rootDir = path.resolve(__dirname, '../../../migrations');
  if (fs.existsSync(distDir)) return distDir;
  if (fs.existsSync(rootDir)) return rootDir;
  return distDir; // runMigrations reports missing migration assets
}

/** Apply the current schema to an independent connection (startup or a staged restore). */
export function migrateDatabase(raw: Database.Database): void {
  runMigrations(raw, getLogger(), resolveMigrationsDir(), CURRENT_SCHEMA_VERSION);
}

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _raw: Database.Database | null = null;
let databaseEpoch = '';

/** In-flight adaptive attempts cannot write into a database opened after restore/restart. */
export function getDatabaseEpoch(): string {
  return databaseEpoch;
}

/** Preserve fresh evidence, but never revive a lease or old outcome fence. */
function resetAdaptiveRuntime(raw: Database.Database, now: number): void {
  raw.transaction(() => {
    raw.prepare(`DELETE FROM combo_adaptive_states
      WHERE updated_at_ms < ? OR updated_at_ms > ?
        OR generation != (SELECT slow_response_generation FROM combos WHERE id=combo_id)`).run(now - 15 * 60_000, now);
    raw.exec(`DELETE FROM combo_adaptive_exploration
      WHERE generation != (SELECT slow_response_generation FROM combos WHERE id=combo_id);
      UPDATE combo_adaptive_states SET generation=generation+1, probe_token=NULL,
        probe_lease_until_ms=NULL, recovery_successes=0, last_start_ms=NULL, last_start_sequence=0;
      UPDATE combo_adaptive_exploration SET generation=generation+1;
      UPDATE combos SET slow_response_generation=slow_response_generation+1;`);
  }).immediate();
}

export interface DbHandle {
  db: BetterSQLite3Database<typeof schema>;
  raw: Database.Database;
}

export function openDb(dbFile: string): DbHandle {
  if (_db && _raw) return { db: _db, raw: _raw };
  const dir = path.dirname(dbFile);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const raw = new Database(dbFile);
  try {
    // Pragmas for WAL + safety
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    raw.pragma('temp_store = MEMORY');
    raw.pragma('cache_size = -20000');

    runMigrations(raw, getLogger(), resolveMigrationsDir(), CURRENT_SCHEMA_VERSION, () => {
      snapshotBeforeIntegrationRemoval(raw);
      getLogger().info('created private pre-0022 SQLite recovery snapshot');
    });
    resetAdaptiveRuntime(raw, Date.now());
    resetCircuits();
    const db = drizzle(raw, { schema });
    databaseEpoch = crypto.randomUUID();
    _raw = raw;
    _db = db;
    return { db, raw };
  } catch (error) {
    raw.close();
    throw error;
  }
}

export function closeDb(): void {
  if (_raw) {
    try {
      _raw.close();
    } catch (e) {
      getLogger().warn({ err: String(e) }, 'failed to close db');
    }
    _raw = null;
    _db = null;
    databaseEpoch = '';
  }
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!_db) throw new Error('Database not opened');
  return _db;
}

export function getRawDb(): Database.Database {
  if (!_raw) throw new Error('Database not opened');
  return _raw;
}

export { schema };
