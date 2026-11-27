import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/server/db/migrate';
import { MIGRATION_LOG, MIGRATIONS_DIR } from '../fixtures/legacy-db';

describe('first-party gateway OAuth migration', () => {
  it('creates constrained OAuth state, cascades key removal and rejects a forged current schema', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
      const digest = 'a'.repeat(64);
      db.prepare('INSERT INTO api_keys(id,name,key_prefix,key_digest) VALUES (?,?,?,?)').run('key', 'OAuth key', 'ld-fixture', digest);
      db.prepare(`INSERT INTO gateway_oauth_grants(id,key_id,key_digest,access_digest,refresh_digest,
        created_at_ms,access_expires_at_ms,refresh_expires_at_ms,absolute_expires_at_ms)
        VALUES (?,?,?,?,?,1,2,3,4)`).run('grant', 'key', digest, 'b'.repeat(64), 'c'.repeat(64));
      db.prepare('INSERT INTO gateway_oauth_used_refresh(token_digest,grant_id) VALUES (?,?)').run('d'.repeat(64), 'grant');
      expect(() => db.prepare(`INSERT INTO gateway_oauth_grants(id,key_id,key_digest,access_digest,refresh_digest,
        created_at_ms,access_expires_at_ms,refresh_expires_at_ms,absolute_expires_at_ms)
        VALUES (?,?,?,?,?,1,4,3,4)`).run('invalid', 'key', digest, 'e'.repeat(64), 'f'.repeat(64))).toThrow();
      db.prepare('DELETE FROM api_keys WHERE id=?').run('key');
      expect(db.prepare('SELECT * FROM gateway_oauth_grants').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM gateway_oauth_used_refresh').all()).toEqual([]);
      db.exec('DROP TABLE gateway_oauth_codes');
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0020/);
    } finally { db.close(); }
  });
});
