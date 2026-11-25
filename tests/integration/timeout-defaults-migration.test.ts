// Migration 0009/0013: the raised timeout defaults reach existing rows, without clobbering
// an admin-tuned value. The client-side watchdog behaviour is covered in upstream-timeouts.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/server/db/migrate';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const logger = { info() {}, warn() {} } as never;

const freshDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-timeouts-'));
  return { db: new Database(path.join(dir, 'test.db')), dir };
};

const timeouts = (db: Database.Database, id: string) =>
  db.prepare('SELECT connect_timeout_ms c, first_token_timeout_ms f, stream_idle_timeout_ms i, total_timeout_ms t FROM providers WHERE id=?').get(id);

describe('timeout default migration', () => {
  it('upgrades providers still on the old defaults and keeps tuned values', () => {
    const { db, dir } = freshDb();
    try {
      const oldMigrations = path.join(dir, 'migrations-before-9');
      fs.mkdirSync(oldMigrations);
      for (const file of fs.readdirSync(migrationsDir).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 8)) {
        fs.copyFileSync(path.join(migrationsDir, file), path.join(oldMigrations, file));
      }
      runMigrations(db, logger, oldMigrations, 8);
      const insert = 'INSERT INTO providers (id,name,slug,type,base_url,connect_timeout_ms,first_token_timeout_ms,stream_idle_timeout_ms,total_timeout_ms) VALUES (?,?,?,?,?,?,?,?,?)';
      db.prepare(insert).run('old', 'Old', 'old', 'openai', 'https://x.test', 10000, 30000, 60000, 180000);
      db.prepare(insert).run('tuned', 'Tuned', 'tuned', 'openai', 'https://x.test', 5000, 45000, 900000, 1500000);

      // Apply 0009–0014 to a genuine pre-0009 database.
      runMigrations(db, logger, migrationsDir);

      expect(timeouts(db, 'old')).toEqual({ c: 60000, f: 60000, i: 300000, t: 600000 });
      expect(timeouts(db, 'tuned')).toEqual({ c: 5000, f: 45000, i: 900000, t: 1500000 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
