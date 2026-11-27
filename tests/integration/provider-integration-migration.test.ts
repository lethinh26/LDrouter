import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '../../src/server/db/migrate';
import { MIGRATIONS_DIR, MIGRATION_LOG } from '../fixtures/legacy-db';

describe('provider integration identity migration 0017', () => {
  it('preserves existing providers and models without guessing integration from names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-integration-'));
    const db = new Database(':memory:');
    try {
      for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 16)) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
      }
      runMigrations(db, MIGRATION_LOG, dir, 16);
      db.exec(`INSERT INTO providers(id,name,slug,type,base_url,encrypted_api_key,api_key_nonce) VALUES
        ('old','Codex relay','codex','openai','https://example.test','encrypted-fixture','nonce-fixture');
        INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES
        ('m','old','same-model','codex/same-model','Same model');`);
      const before = db.prepare('SELECT * FROM providers').all();
      const models = db.prepare('SELECT * FROM models').all();
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(db.prepare('SELECT * FROM providers').all()).toEqual(before);
      expect(db.prepare('SELECT * FROM models').all()).toEqual(models);
      expect(db.prepare('SELECT * FROM provider_integrations').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('codex_accounts','qoder_accounts')").all()).toEqual([]);
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(db.prepare('SELECT * FROM providers').all()).toEqual(before);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('enforces identity and mode, prevents orphan rows, and deletes metadata with its provider', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      db.exec("INSERT INTO providers(id,name,slug,type,base_url) VALUES ('c','Codex','codex','openai','https://chatgpt.com')");
      const insert = db.prepare('INSERT INTO provider_integrations VALUES (?,?,?)');
      expect(() => insert.run('c','codex','api_key')).toThrow(/CHECK/);
      expect(() => insert.run('c','claude_code','client_oauth')).toThrow(/CHECK/);
      expect(() => insert.run('missing','codex','client_oauth')).toThrow(/FOREIGN KEY/);
      insert.run('c','codex','client_oauth');
      expect(() => insert.run('c','codex','client_oauth')).toThrow(/UNIQUE/);
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      db.exec("DELETE FROM providers WHERE id='c'");
      expect(db.prepare('SELECT * FROM provider_integrations').all()).toEqual([]);
    } finally { db.close(); }
  });

  it.each(['missing-table','credential','origin','protocol'] as const)('rejects forged current schema with invalid integration: %s', (damage) => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      db.exec("INSERT INTO providers(id,name,slug,type,base_url) VALUES ('c','Codex','codex','openai','https://chatgpt.com'); INSERT INTO provider_integrations VALUES ('c','codex','client_oauth')");
      if (damage === 'missing-table') db.exec('DROP TABLE provider_integrations');
      if (damage === 'credential') db.exec("UPDATE providers SET encrypted_api_key='unexpected',api_key_nonce='unexpected' WHERE id='c'");
      if (damage === 'origin') db.exec("UPDATE providers SET base_url='https://example.test' WHERE id='c'");
      if (damage === 'protocol') db.exec("UPDATE providers SET type='anthropic' WHERE id='c'");
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0017/);
    } finally { db.close(); }
  });
});
