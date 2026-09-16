import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/server/db/migrate';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const logger = { info() {}, warn() {} } as never;

function freshDb(prefix: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'test.db');
  return { db: new Database(file), dir: path.dirname(file) };
}

describe('Qoder schema migration', () => {
  it('creates qoder_accounts and the attempt reference on an empty database', () => {
    const { db, dir } = freshDb('latedev-qoder-schema-');
    try {
      runMigrations(db, logger, migrationsDir);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qoder_accounts'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM pragma_table_info('request_attempts') WHERE name='qoder_account_id'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_qoder_account_provider_enabled_priority'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_qoder_account_provider_user'").get()).toBeTruthy();
      const columns = db.prepare(`SELECT name, "notnull" FROM pragma_table_info('qoder_accounts')`).all() as { name: string; notnull: number }[];
      for (const required of ['provider_id', 'qoder_user_id', 'machine_id', 'encrypted_pat', 'encrypted_job_token', 'job_token_expires_at']) {
        expect(columns.find((column) => column.name === required)?.notnull).toBe(1);
      }
      expect(columns.find((column) => column.name === 'catalog_json')?.notnull).toBe(0);
      expect(columns.find((column) => column.name === 'email')?.notnull).toBe(0);
      expect(db.prepare(`SELECT "notnull" FROM pragma_table_info('request_attempts') WHERE name='qoder_account_id'`).get()).toEqual({ notnull: 0 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts type qoder and rejects an unknown type', () => {
    const { db, dir } = freshDb('latedev-qoder-check-');
    try {
      runMigrations(db, logger, migrationsDir);
      db.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('qp','Qoder','qoder','qoder','https://api2.qoder.sh')").run();
      expect(db.prepare("SELECT type FROM providers WHERE id='qp'").get()).toEqual({ type: 'qoder' });
      expect(() => db.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('bp','Bad','bad','gemini','https://x.test')").run()).toThrow(/CHECK/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the provider graph and foreign keys when upgrading an existing database', () => {
    const { db, dir } = freshDb('latedev-qoder-upgrade-');
    try {
      db.exec(fs.readFileSync(path.join(migrationsDir, '0001_initial_schema.sql'), 'utf8'));
      db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (1, ?)').run('initial_schema');
      db.prepare("INSERT INTO providers (id,name,slug,type,base_url,encrypted_api_key,api_key_nonce) VALUES ('p1','OpenAI','openai','openai','https://example.test','e','n')").run();
      db.prepare("INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('m1','p1','gpt-test','openai/gpt-test','GPT')").run();
      db.prepare("INSERT INTO combos (id,name,slug,public_model_id,mode) VALUES ('cb1','Combo','combo-a','combo-a','fallback')").run();
      db.prepare("INSERT INTO combo_members (id,combo_id,model_id,position) VALUES ('cm1','cb1','m1',0)").run();

      runMigrations(db, logger, migrationsDir);

      expect(db.prepare("SELECT name FROM providers WHERE id='p1'").get()).toEqual({ name: 'OpenAI' });
      expect(db.prepare("SELECT provider_id FROM models WHERE id='m1'").get()).toEqual({ provider_id: 'p1' });
      expect(db.prepare("SELECT combo_id, model_id FROM combo_members WHERE id='cm1'").get()).toEqual({ combo_id: 'cb1', model_id: 'm1' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
