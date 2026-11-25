import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '../../src/server/db/migrate';
import { createLegacyDatabase, MIGRATIONS_DIR, MIGRATION_LOG } from '../fixtures/legacy-db';

describe('retired provider migration 0014', () => {
  it('upgrades mixed configuration without losing history or broadening ACLs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-legacy-migrate-'));
    const db = createLegacyDatabase(dir);
    try {
      const tables = ['requests', 'daily_model_stats', 'daily_provider_stats', 'daily_api_key_stats', 'audit_logs', 'usage_daily', 'usage_monthly'];
      const snapshot = () => tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
      const history = snapshot();
      const attempts = db.prepare('SELECT * FROM request_attempts ORDER BY id').all().map(row => {
        const { codex_account_id: _a, qoder_account_id: _b, ...rest } = row as Record<string, unknown>;
        return rest;
      });
      const providers = db.prepare("SELECT * FROM providers WHERE type IN ('openai','anthropic') ORDER BY id").all();
      const models = db.prepare("SELECT * FROM models WHERE provider_id IN ('p-openai','p-anthropic') ORDER BY id").all();
      // Verify 0014's historical slow-state preservation against its own immutable prefix.
      const through14 = path.join(dir,'migrations-through-14');
      fs.mkdirSync(through14);
      for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0,4)) <= 14)) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR,file),path.join(through14,file));
      }
      runMigrations(db, MIGRATION_LOG, through14, 14);
      expect(db.prepare("SELECT * FROM providers ORDER BY id").all()).toEqual(providers);
      expect(db.prepare("SELECT * FROM models ORDER BY id").all()).toEqual(models);
      expect(snapshot()).toEqual(history);
      expect(db.prepare('SELECT * FROM request_attempts ORDER BY id').all()).toEqual(attempts);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%codex%' OR name LIKE '%qoder%'").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM pragma_table_info('request_attempts') WHERE name LIKE '%account_id'").all()).toEqual([]);
      expect(db.prepare('SELECT id,enabled,config_version FROM combos ORDER BY id').all()).toEqual([
        {id:'disabled',enabled:0,config_version:3},
        {id:'empty',enabled:0,config_version:8},
        {id:'mixed',enabled:1,config_version:5},
        {id:'untouched',enabled:1,config_version:3},
      ]);
      expect(db.prepare("SELECT id,model_id,position FROM combo_members WHERE combo_id='mixed' ORDER BY position").all()).toEqual([
        {id:'member-openai',model_id:'m-openai',position:1},
        {id:'member-anthropic',model_id:'m-anthropic',position:3},
      ]);
      expect(db.prepare('SELECT combo_id,model_id,consecutive_slow_count FROM combo_member_slow_states ORDER BY combo_id,model_id').all()).toEqual([
        {combo_id:'mixed',model_id:'m-anthropic',consecutive_slow_count:1},
        {combo_id:'mixed',model_id:'m-openai',consecutive_slow_count:2},
        {combo_id:'untouched',model_id:'m-anthropic',consecutive_slow_count:4},
      ]);
      expect(db.prepare('SELECT id,enabled,config_version FROM model_aliases ORDER BY id').all()).toEqual([
        {id:'alias-empty',enabled:0,config_version:7},
        {id:'alias-keep',enabled:1,config_version:2},
        {id:'alias-mixed',enabled:1,config_version:6},
      ]);
      expect(db.prepare('SELECT id,allow_all_models FROM api_keys ORDER BY id').all()).toEqual([
        {id:'key-all',allow_all_models:1},{id:'key-legacy',allow_all_models:0},{id:'key-mixed',allow_all_models:0},
      ]);
      expect(db.prepare('SELECT id FROM api_key_model_permissions ORDER BY id').all()).toEqual([
        {id:'perm-mixed-alias'},{id:'perm-mixed-combo'},{id:'perm-mixed-empty'},{id:'perm-mixed-keep'},
      ]);
      expect(db.prepare('SELECT id FROM response_cache ORDER BY id').all()).toEqual([
        {id:'cache-alias-keep'},{id:'cache-keep'},{id:'cache-untouched'},
      ]);
      expect(db.prepare('SELECT schema_version FROM app_settings WHERE id=1').get()).toEqual({schema_version:14});
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.pragma('foreign_keys',{simple:true})).toBe(1);
      expect(() => db.exec("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('invalid','invalid','invalid','codex','https://example.test')")).toThrow(/CHECK constraint/);
      expect(() => db.exec("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('invalid','invalid','invalid','qoder','https://example.test')")).toThrow(/CHECK constraint/);
      expect(() => db.exec("INSERT INTO combo_members (id,combo_id,model_id,position) VALUES ('invalid','mixed','m-retired-a',9)")).toThrow(/FOREIGN KEY/);
      runMigrations(db, MIGRATION_LOG, through14, 14);
      expect(snapshot()).toEqual(history);
      expect(db.prepare('SELECT config_version FROM combos WHERE id=?').get('mixed')).toEqual({config_version:5});
      db.exec("DELETE FROM combo_members WHERE id='member-openai'");
      expect(db.prepare("SELECT * FROM combo_member_slow_states WHERE combo_id='mixed' AND model_id='m-openai'").get()).toBeUndefined();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='combo_member_slow_states'").get()).toBeUndefined();
      expect(db.prepare('SELECT * FROM combo_adaptive_states').all()).toEqual([]);
      expect(snapshot()).toEqual(history);
    } finally {
      db.close();
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });

  it('requires complete assets for a fresh database and bootstraps only from immutable SQL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-bootstrap-'));
    const db = new Database(':memory:');
    try {
      expect(() => runMigrations(db, MIGRATION_LOG, path.join(dir,'missing'), CURRENT_SCHEMA_VERSION)).toThrow(/missing/);
      fs.copyFileSync(path.join(MIGRATIONS_DIR,'0001_initial_schema.sql'),path.join(dir,'0001_initial_schema.sql'));
      expect(() => runMigrations(db,MIGRATION_LOG,dir,CURRENT_SCHEMA_VERSION)).toThrow(/incomplete/);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
      runMigrations(db,MIGRATION_LOG,MIGRATIONS_DIR,CURRENT_SCHEMA_VERSION);
      expect(db.prepare('SELECT schema_version FROM app_settings').get()).toEqual({schema_version:CURRENT_SCHEMA_VERSION});
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('codex_accounts','qoder_accounts')").all()).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });

  it('rejects a future migration ledger without modifying settings', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db,MIGRATION_LOG,MIGRATIONS_DIR,CURRENT_SCHEMA_VERSION);
      db.exec("INSERT INTO schema_migrations(version,name) VALUES (16,'future'); UPDATE app_settings SET schema_version=16");
      expect(() => runMigrations(db,MIGRATION_LOG,MIGRATIONS_DIR,CURRENT_SCHEMA_VERSION)).toThrow(/newer/);
      expect(db.prepare('SELECT schema_version FROM app_settings').get()).toEqual({schema_version:16});
    } finally { db.close(); }
  });

  it.each([false, true])('does not let a false schema stamp bypass 0014 (forged ledger: %s)', (forgedLedger) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-false-schema-'));
    const db = createLegacyDatabase(dir);
    try {
      db.exec('UPDATE app_settings SET schema_version=14 WHERE id=1');
      if (forgedLedger) {
        db.exec("INSERT INTO schema_migrations(version,name) VALUES (14,'remove_legacy_providers')");
        expect(() => runMigrations(db,MIGRATION_LOG,MIGRATIONS_DIR,CURRENT_SCHEMA_VERSION)).toThrow(/inconsistent.*0014/);
        expect(db.prepare("SELECT COUNT(*) n FROM providers WHERE type IN ('codex','qoder')").get()).toEqual({n:2});
      } else {
        runMigrations(db,MIGRATION_LOG,MIGRATIONS_DIR,CURRENT_SCHEMA_VERSION);
        expect(db.prepare("SELECT COUNT(*) n FROM providers WHERE type IN ('codex','qoder')").get()).toEqual({n:0});
      }
    } finally {
      db.close();
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });

  it.each([
    'account-table', 'attempt-column', 'loose-provider-constraint', 'invalid-provider-row',
  ] as const)('rejects a current ledger with residual schema or data: %s', (damage) => {
    const db = new Database(':memory:');
    try {
      runMigrations(db,MIGRATION_LOG,MIGRATIONS_DIR,CURRENT_SCHEMA_VERSION);
      if (damage === 'account-table') {
        db.exec('CREATE TABLE QODER_ACCOUNTS(id TEXT PRIMARY KEY)');
      } else if (damage === 'attempt-column') {
        db.exec('ALTER TABLE request_attempts ADD COLUMN codex_account_id TEXT');
      } else if (damage === 'loose-provider-constraint') {
        const {sql} = db.prepare("SELECT sql FROM sqlite_schema WHERE name='providers'").get() as {sql:string};
        db.pragma('foreign_keys = OFF');
        db.exec('DROP TABLE providers');
        db.exec(sql.replace("'openai','anthropic'", "'openai','anthropic','codex','qoder'"));
        db.pragma('foreign_keys = ON');
      } else {
        db.pragma('ignore_check_constraints = ON');
        db.exec("INSERT INTO providers(id,name,slug,type,base_url) VALUES ('bad','Bad','bad','qoder','https://example.test')");
        db.pragma('ignore_check_constraints = OFF');
      }
      expect(() => runMigrations(db,MIGRATION_LOG,MIGRATIONS_DIR,CURRENT_SCHEMA_VERSION)).toThrow(/inconsistent.*0014/);
    } finally { db.close(); }
  });
});
