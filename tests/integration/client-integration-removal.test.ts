import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/server/db/migrate';
import { snapshotBeforeIntegrationRemoval } from '../../src/server/db/rollback-snapshot';
import { createLegacyDatabase, MIGRATION_LOG, MIGRATIONS_DIR } from '../fixtures/legacy-db';

function prefix(dir: string, version: number): string {
  const target = path.join(dir, `migrations-${version}`);
  fs.mkdirSync(target);
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= version)) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(target, file));
  }
  return target;
}

const retiredObjects = ['provider_integrations', 'provider_connections', 'provider_connection_default', 'gateway_oauth_codes', 'gateway_oauth_grants', 'gateway_oauth_used_refresh', 'subscription_quota_accounts'];
function assertRemoved(db: Database.Database) {
  for (const name of retiredObjects) {
    expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(name)).toBeUndefined();
  }
  expect(db.prepare("SELECT name FROM pragma_table_xinfo('combos') WHERE name='combo_kind'").get()).toBeUndefined();
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare('SELECT schema_version FROM app_settings').get()).toEqual({ schema_version: CURRENT_SCHEMA_VERSION });
}

describe('forward rollback of client integrations (0022)', () => {
  it('retires only explicit integration configuration and keeps ordinary routes, permissions and history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldrouter-remove-integrations-'));
    const db = createLegacyDatabase(dir);
    try {
      runMigrations(db, MIGRATION_LOG, prefix(dir, 21), 21);
      db.pragma('journal_mode = WAL');
      db.exec(`
        INSERT INTO providers(id,name,slug,type,base_url,encrypted_api_key,api_key_nonce) VALUES
          ('p-client-codex','Client Codex','builtin-connection-p-client-codex','openai','https://chatgpt.com',NULL,NULL),
          ('p-client-claude','Client Claude','claude-fixture','anthropic','https://api.anthropic.com','fixture-ciphertext','fixture-nonce'),
          ('p-lookalike','Codex compatible','codex','openai','https://example.test',NULL,NULL);
        INSERT INTO provider_integrations(provider_id,provider_kind,auth_mode) VALUES
          ('p-client-codex','codex','client_oauth'),('p-client-claude','claude_code','api_key');
        UPDATE provider_connections SET namespace_mode='canonical' WHERE provider_id='p-client-codex';
        INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name) VALUES
          ('m-client-codex','p-client-codex','fixture','cx/fixture','Native Codex'),
          ('m-client-claude','p-client-claude','fixture','claude-fixture/fixture','Native Claude'),
          ('m-lookalike','p-lookalike','claude-compatible','codex/claude-compatible','Ordinary model');
        INSERT INTO combos(id,name,slug,public_model_id,mode,combo_kind,fallback_on_429,slow_response_fallback_enabled) VALUES
          ('native-new','Native','native-new','combo/native-new','fallback','codex_native',0,0),
          ('only-claude','Only Claude','only-claude','combo/only-claude','fallback','standard',1,1);
        INSERT INTO combo_members(id,combo_id,model_id,position) VALUES
          ('new-native-member','native-new','m-client-codex',0),
          ('new-claude-mixed','mixed','m-client-claude',8),
          ('new-claude-only','only-claude','m-client-claude',0);
        INSERT INTO model_aliases(id,alias,target_kind,target_id) VALUES
          ('alias-native-new','native-new-alias','combo','native-new'),
          ('alias-client-claude','client-claude-alias','model','m-client-claude'),
          ('alias-only-claude','only-claude-alias','combo','only-claude');
        UPDATE api_keys SET total_token_limit=500 WHERE id='key-legacy';
        INSERT INTO api_key_model_permissions(id,api_key_id,target_kind,target_id) VALUES
          ('perm-native-new','key-legacy','combo','native-new'),
          ('perm-native-alias','key-legacy','alias','alias-native-new'),
          ('perm-client-claude','key-legacy','model','m-client-claude'),
          ('perm-lookalike','key-mixed','model','m-lookalike');
        INSERT INTO response_cache(id,cache_key,target_kind,target_id,protocol,response_json,expires_at) VALUES
          ('cache-client-claude','cache-client-claude','model','m-client-claude','anthropic','{}','2030-01-01T00:00:00Z'),
          ('cache-native-new','cache-native-new','combo','native-new','openai','{}','2030-01-01T00:00:00Z'),
          ('cache-native-alias','cache-native-alias','alias','alias-native-new','openai','{}','2030-01-01T00:00:00Z'),
          ('cache-mixed-now','cache-mixed-now','combo','mixed','openai','{}','2030-01-01T00:00:00Z'),
          ('cache-mixed-alias-now','cache-mixed-alias-now','alias','alias-mixed','openai','{}','2030-01-01T00:00:00Z');
        INSERT INTO combo_adaptive_states(combo_id,member_id,model_id,workload,generation,updated_at_ms)
          SELECT c.id,cm.id,cm.model_id,'stream:plain:short',c.slow_response_generation,1
          FROM combo_members cm JOIN combos c ON c.id=cm.combo_id WHERE cm.id IN ('member-openai','member-untouched');
        INSERT INTO combo_adaptive_exploration(combo_id,workload,generation,next_due_ms)
          SELECT id,'stream:plain:short',slow_response_generation,1 FROM combos WHERE id IN ('mixed','untouched');
        INSERT INTO gateway_oauth_grants(id,key_id,key_digest,access_digest,refresh_digest,access_expires_at_ms,refresh_expires_at_ms,absolute_expires_at_ms,created_at_ms)
          VALUES ('fixture-grant','key-legacy','${'a'.repeat(64)}','${'b'.repeat(64)}','${'c'.repeat(64)}',200,300,400,100);
        INSERT INTO gateway_oauth_used_refresh(token_digest,grant_id) VALUES ('${'d'.repeat(64)}','fixture-grant');
        INSERT INTO subscription_quota_accounts(id,provider_kind,name,created_at_ms,updated_at_ms)
          VALUES ('fixture-quota','codex','Quota fixture',100,100);
        INSERT INTO requests(id,api_key_id,client_ip,protocol,endpoint,requested_model,resolved_target_kind,resolved_target_id,final_model_id,streaming,http_status,success)
          VALUES ('request-client-new','key-legacy','127.0.0.1','openai','/backend-api/codex/responses','cx/fixture','model','m-client-codex','m-client-codex',0,200,1);
        INSERT INTO request_attempts(id,request_id,attempt_number,provider_id,model_id,started_at,success,selection_reason)
          VALUES ('attempt-client-new','request-client-new',1,'p-client-codex','m-client-codex','2026-11-27T00:00:00Z',1,'primary');
        INSERT INTO daily_provider_stats(day,provider_id,attempts,successful_attempts) VALUES ('2026-11-27','p-client-codex',1,1);
      `);
      const historyTables = ['requests','request_attempts','daily_model_stats','daily_provider_stats','daily_api_key_stats','usage_daily','usage_monthly','audit_logs','api_keys','api_key_ip_rules'];
      const history = () => historyTables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
      const originalHistory = history();
      const ordinaryProviders = db.prepare("SELECT * FROM providers WHERE id NOT IN ('p-client-codex','p-client-claude') ORDER BY id").all();
      const ordinaryModels = db.prepare("SELECT * FROM models WHERE provider_id NOT IN ('p-client-codex','p-client-claude') ORDER BY id").all();
      const originalUntouched = db.prepare("SELECT config_version,slow_response_generation FROM combos WHERE id='untouched'").get();
      const beforeMixed = db.prepare("SELECT config_version,slow_response_generation FROM combos WHERE id='mixed'").get() as { config_version: number; slow_response_generation: number };
      // Backup failure must leave the old schema and data intact.
      expect(() => runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION, () => { throw new Error('snapshot failed'); })).toThrow('snapshot failed');
      expect(db.prepare('SELECT count(*) AS n FROM provider_integrations').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 21 });
      expect(history()).toEqual(originalHistory);

      let copied = 0;
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION, () => {
        snapshotBeforeIntegrationRemoval(db); copied++;
      });
      expect(copied).toBe(1);
      assertRemoved(db);
      expect(history()).toEqual(originalHistory);
      expect(db.prepare('SELECT * FROM providers ORDER BY id').all()).toEqual(ordinaryProviders);
      expect(db.prepare('SELECT * FROM models ORDER BY id').all()).toEqual(ordinaryModels);
      expect(db.prepare("SELECT id FROM combos WHERE id='native-new'").get()).toBeUndefined();
      expect(db.prepare("SELECT id,enabled FROM combos WHERE id='only-claude'").get()).toEqual({ id: 'only-claude', enabled: 0 });
      expect(db.prepare("SELECT id,enabled FROM model_aliases WHERE id='alias-only-claude'").get()).toEqual({ id: 'alias-only-claude', enabled: 0 });
      expect(db.prepare("SELECT id FROM model_aliases WHERE id IN ('alias-native-new','alias-client-claude')").all()).toEqual([]);
      expect(db.prepare("SELECT id,position FROM combo_members WHERE combo_id='mixed' ORDER BY position").all()).toEqual([{ id: 'member-openai', position: 1 }, { id: 'member-anthropic', position: 3 }]);
      expect(db.prepare("SELECT config_version,slow_response_generation FROM combos WHERE id='mixed'").get()).toEqual({ config_version: beforeMixed.config_version + 1, slow_response_generation: beforeMixed.slow_response_generation + 1 });
      expect(db.prepare("SELECT config_version,slow_response_generation FROM combos WHERE id='untouched'").get()).toEqual(originalUntouched);
      expect(db.prepare('SELECT combo_id FROM combo_adaptive_states').all()).toEqual([{ combo_id: 'untouched' }]);
      expect(db.prepare('SELECT combo_id FROM combo_adaptive_exploration').all()).toEqual([{ combo_id: 'untouched' }]);
      expect(db.prepare("SELECT count(*) AS n FROM api_key_model_permissions WHERE api_key_id='key-legacy'").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT allow_all_models,total_token_limit FROM api_keys WHERE id='key-legacy'").get()).toEqual({ allow_all_models: 0, total_token_limit: 500 });
      expect(db.prepare("SELECT id FROM api_key_model_permissions WHERE id='perm-lookalike'").get()).toEqual({ id: 'perm-lookalike' });
      expect(db.prepare('SELECT id FROM response_cache ORDER BY id').all()).toEqual([{ id: 'cache-alias-keep' }, { id: 'cache-keep' }, { id: 'cache-untouched' }]);
      const recovery = new Database(path.join(db.name + '.pre-0022','data.sqlite'), { readonly: true });
      try {
        expect(recovery.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 21 });
        expect(recovery.prepare('SELECT count(*) AS n FROM provider_integrations').get()).toEqual({ n: 2 });
        expect(recovery.prepare('SELECT count(*) AS n FROM subscription_quota_accounts').get()).toEqual({ n: 1 });
        expect(recovery.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      } finally { recovery.close(); }
      runMigrations(db, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION, () => { throw new Error('must not snapshot twice'); });
      assertRemoved(db);
      expect(history()).toEqual(originalHistory);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('fresh schema matches the pre-integration schema and rejects forged retirement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldrouter-rollback-schema-'));
    const old = new Database(':memory:');
    const current = new Database(':memory:');
    try {
      runMigrations(old, MIGRATION_LOG, prefix(dir, 16), 16);
      runMigrations(current, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION, () => { throw new Error('fresh database must not create backup'); });
      assertRemoved(current);
      const objects = (db: Database.Database) => db.prepare("SELECT type,name,tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      expect(objects(current)).toEqual(objects(old));
      for (const { name } of old.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
        const cols = (db: Database.Database) => db.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').all(name);
        expect(cols(current)).toEqual(cols(old));
      }
      current.exec('CREATE TABLE subscription_quota_accounts(id TEXT)');
      expect(() => runMigrations(current, MIGRATION_LOG, MIGRATIONS_DIR, CURRENT_SCHEMA_VERSION)).toThrow(/0022/);
    } finally { old.close(); current.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
