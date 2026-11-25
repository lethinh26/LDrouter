// Database bootstrap: opens SQLite WAL, applies pending migrations, returns a Drizzle DB handle.

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { getLogger } from '../logging/logger';
import { CURRENT_SCHEMA_VERSION, runMigrations } from './migrate';

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

    migrateDatabase(raw);
    const db = drizzle(raw, { schema });
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
