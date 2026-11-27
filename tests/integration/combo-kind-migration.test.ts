import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/server/db/migrate';
import { MIGRATION_LOG, MIGRATIONS_DIR } from '../fixtures/legacy-db';

const fixture = (db: Database.Database) => db.exec(`
  INSERT INTO providers(id,name,slug,type,base_url) VALUES ('a','a','a','openai','https://chatgpt.com'),('b','b','b','openai','https://chatgpt.com'),('p','p','p','openai','https://example.test');
  INSERT INTO provider_integrations VALUES ('a','codex','client_oauth'),('b','codex','client_oauth');
  INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('ma','a','one','a/one','one'),('mb','a','two','a/two','two'),('md','b','one','b/one','duplicate'),('mp','p','one','p/one','standard');
`);

function native(db: Database.Database) {
  db.exec(`INSERT INTO combos(id,name,slug,public_model_id,mode,combo_kind,fallback_on_429,slow_response_fallback_enabled) VALUES ('native','Native','native','native','fallback','codex_native',0,0);
    INSERT INTO combo_members(id,combo_id,model_id,position) VALUES ('member-a','native','ma',0),('member-b','native','mb',1);`);
}

describe('combo kind migration 0018', () => {
  it('preserves old combo settings and membership, defaults to standard, and reruns safely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-combo-kind-'));
    const db = new Database(':memory:');
    try {
      for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 17)) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
      runMigrations(db, MIGRATION_LOG, dir, 17);
      fixture(db);
      db.exec("INSERT INTO combos(id,name,slug,public_model_id,mode) VALUES ('old','Old','old','old','fallback'); INSERT INTO combo_members(id,combo_id,model_id,position) VALUES ('old-member','old','mp',0)");
      const before = db.prepare('SELECT * FROM combos').get();
      const members = db.prepare('SELECT * FROM combo_members').all();
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
      expect(db.prepare('SELECT * FROM combos').get()).toEqual({ ...(before as object), combo_kind: 'standard' });
      expect(db.prepare('SELECT * FROM combo_members').all()).toEqual(members);
      native(db);
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(db.prepare('SELECT combo_kind FROM combos ORDER BY id').all()).toEqual([{ combo_kind: 'codex_native' }, { combo_kind: 'standard' }]);
      expect(() => db.exec("UPDATE combos SET combo_kind='other' WHERE id='old'")).toThrow(/CHECK/);
      expect(() => db.exec("UPDATE combos SET fallback_on_429=1 WHERE id='native'")).toThrow(/CHECK/);
      expect(() => db.exec("UPDATE combos SET slow_response_fallback_enabled=1 WHERE id='native'")).toThrow(/CHECK/);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['mixed native', "INSERT INTO combo_members(id,combo_id,model_id,position,enabled) VALUES ('mixed','native','mp',2,0)"],
    ['duplicate upstream', "INSERT INTO combo_members(id,combo_id,model_id,position,enabled) VALUES ('duplicate','native','md',2,0)"],
    ['standard with native members', "UPDATE combos SET combo_kind='standard' WHERE id='native'"],
    ['429', "UPDATE combos SET fallback_on_429=1 WHERE id='native'"],
    ['adaptive', "UPDATE combos SET slow_response_fallback_enabled=1 WHERE id='native'"],
    ['adaptive state', "INSERT INTO combo_adaptive_states(combo_id,member_id,model_id,workload,generation) VALUES ('native','member-a','ma','stream:plain:short',1)"],
    ['adaptive exploration', "INSERT INTO combo_adaptive_exploration(combo_id,workload,generation,next_due_ms) VALUES ('native','stream:plain:short',1,0)"],
  ])('rejects a claimed 0018 database containing %s', (_label, damage) => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      fixture(db); native(db);
      db.pragma('ignore_check_constraints = ON');
      db.exec(damage);
      db.pragma('ignore_check_constraints = OFF');
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0018/);
    } finally { db.close(); }
  });

  it('rejects a claimed 0018 database missing the kind column', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      db.exec('ALTER TABLE combos DROP COLUMN combo_kind');
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0018/);
    } finally { db.close(); }
  });

  it('rejects a claimed 0018 database with the kind column but without its policy checks', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      db.exec("ALTER TABLE combos DROP COLUMN combo_kind; ALTER TABLE combos ADD COLUMN combo_kind TEXT NOT NULL DEFAULT 'standard'");
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0018/);
    } finally { db.close(); }
  });
});
