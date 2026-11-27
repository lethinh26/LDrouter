import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/server/db/migrate';
import { MIGRATION_LOG, MIGRATIONS_DIR } from '../fixtures/legacy-db';

describe('subscription quota migration', () => {
  it('upgrades schema 20 without changing existing providers or gateway grants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldrouter-quota-migration-'));
    const db = new Database(':memory:');
    try {
      for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
        if (/^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 20) {
          fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
        }
      }
      runMigrations(db, MIGRATION_LOG, dir, 20);
      db.prepare("INSERT INTO providers(id,name,slug,type,base_url) VALUES ('p','Compatible','compatible','openai','https://example.test')").run();
      db.prepare("INSERT INTO api_keys(id,name,key_prefix,key_digest) VALUES ('k','Key','ld-fixture',?)").run('a'.repeat(64));
      db.prepare("INSERT INTO gateway_oauth_grants(id,key_id,key_digest,access_digest,refresh_digest,created_at_ms,access_expires_at_ms,refresh_expires_at_ms,absolute_expires_at_ms) VALUES ('g','k',?,?,?,1,2,3,4)").run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64));
      const before = db.prepare('SELECT * FROM gateway_oauth_grants').all();
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
      expect(db.prepare('SELECT * FROM gateway_oauth_grants').all()).toEqual(before);
      expect(db.prepare('SELECT slug FROM providers').all()).toEqual([{ slug: 'compatible' }]);
      const insert = db.prepare('INSERT INTO subscription_quota_accounts(id,provider_kind,name,account_fingerprint,snapshot_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,1,1)');
      insert.run('a', 'codex', 'Personal', 'd'.repeat(64), null);
      insert.run('b', 'claude_code', 'Personal', null, null);
      expect(() => insert.run('c', 'codex', 'personal', null, null)).toThrow();
      expect(() => insert.run('d', 'codex', 'Duplicate identity', 'd'.repeat(64), null)).toThrow();
      expect(() => insert.run('e', 'claude_code', 'Invalid identity', 'e'.repeat(64), null)).toThrow();
      expect(() => insert.run('f', 'codex', 'Invalid snapshot', null, 'not json')).toThrow();
      expect(() => insert.run('g', 'unknown', 'Unknown provider', null, null)).toThrow();
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(db.prepare('SELECT count(*) AS n FROM subscription_quota_accounts').get()).toEqual({ n: 2 });
      db.exec('DROP TABLE subscription_quota_accounts');
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0021/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
