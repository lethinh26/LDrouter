import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/server/db/migrate';
import { MIGRATION_LOG, MIGRATIONS_DIR } from '../fixtures/legacy-db';

describe('built-in connection migration 0019', () => {
  it('adopts existing integration identities without changing credential ownership, model IDs, aliases, combo members or ACLs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-connection-migration-'));
    const db = new Database(':memory:');
    try {
      for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 18)) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
      }
      runMigrations(db, MIGRATION_LOG, dir, 18);
      db.exec(`
        INSERT INTO providers(id,name,slug,type,base_url) VALUES
          ('old-codex','Old Codex','old-codex','openai','https://chatgpt.com'),
          ('custom-cx','Existing custom','cx','openai','https://example.test');
        INSERT INTO providers(id,name,slug,type,base_url,encrypted_api_key,api_key_nonce) VALUES
          ('old-claude','Old Claude','old-claude','anthropic','https://api.anthropic.com','cipher-fixture','nonce-fixture');
        INSERT INTO provider_integrations VALUES ('old-codex','codex','client_oauth'),('old-claude','claude_code','api_key');
        INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES
          ('model-codex','old-codex','one','old-codex/one','One'),
          ('model-claude','old-claude','two','old-claude/two','Two'),
          ('custom-model','custom-cx','one','cx/one','Custom');
        INSERT INTO combos(id,name,slug,public_model_id,mode,combo_kind,fallback_on_429,slow_response_fallback_enabled)
          VALUES ('combo-codex','Legacy combo','legacy-combo','combo/legacy-combo','fallback','codex_native',0,0);
        INSERT INTO combo_members(id,combo_id,model_id,position) VALUES ('member','combo-codex','model-codex',0);
        INSERT INTO model_aliases(id,alias,target_kind,target_id) VALUES ('alias','legacy-alias','model','model-claude');
        INSERT INTO api_keys(id,name,key_prefix,key_digest,allow_all_models) VALUES ('scoped','Scoped','ld-test','digest-fixture',0);
        INSERT INTO api_key_model_permissions(id,api_key_id,target_kind,target_id) VALUES ('perm','scoped','alias','alias');
      `);
      const tables = ['providers','provider_integrations','models','combos','combo_members','model_aliases','api_keys','api_key_model_permissions'];
      const before = tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all());
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
      expect(tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all())).toEqual(before);
      expect(db.prepare('SELECT * FROM provider_connections ORDER BY provider_id').all()).toEqual([
        { provider_id: 'old-claude', namespace_mode: 'legacy' },
        { provider_id: 'old-codex', namespace_mode: 'legacy' },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      expect(tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all())).toEqual(before);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['missing-table','missing-trigger','missing-connection','invalid-slug','invalid-model-prefix','duplicate-profile'] as const)('rejects forged current connection schema: %s', damage => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      db.exec(`
        INSERT INTO providers(id,name,slug,type,base_url) VALUES ('fixture','Profile','builtin-connection-fixture','openai','https://chatgpt.com');
        INSERT INTO provider_integrations VALUES ('fixture','codex','client_oauth');
        UPDATE provider_connections SET namespace_mode='canonical' WHERE provider_id='fixture';
        INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('model','fixture','one','cx/one','One');
      `);
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION);
      if (damage === 'missing-table') db.exec('DROP TABLE provider_connections');
      if (damage === 'missing-trigger') db.exec('DROP TRIGGER provider_connection_default');
      if (damage === 'missing-connection') db.exec("DELETE FROM provider_connections WHERE provider_id='fixture'");
      if (damage === 'invalid-slug') db.exec("UPDATE providers SET slug='other' WHERE id='fixture'");
      if (damage === 'invalid-model-prefix') db.exec("UPDATE models SET public_model_id='other/one' WHERE id='model'");
      if (damage === 'duplicate-profile') db.exec(`
        INSERT INTO providers(id,name,slug,type,base_url) VALUES ('second','Second','builtin-connection-second','openai','https://chatgpt.com');
        INSERT INTO provider_integrations VALUES ('second','codex','client_oauth');
        UPDATE provider_connections SET namespace_mode='canonical' WHERE provider_id='second';
      `);
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0019/);
    } finally { db.close(); }
  });
});
