import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations,CURRENT_SCHEMA_VERSION } from '../../src/server/db/migrate';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const logger = { info() {}, warn() {} } as never;
const workload = 'stream:plain:short';

function prefix(dir: string,version: number): string {
  const target = path.join(dir,'migrations-'+version);
  fs.mkdirSync(target);
  for (const file of fs.readdirSync(migrationsDir).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0,4)) <= version)) {
    fs.copyFileSync(path.join(migrationsDir,file),path.join(target,file));
  }
  return target;
}

function seed(raw: Database.Database): void {
  raw.exec(`
    INSERT INTO providers(id,name,slug,type,base_url) VALUES ('p1','P1','p1','openai','https://example.test');
    INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name)
      VALUES ('m1','p1','m1','p1/m1','M1'),('m2','p1','m2','p1/m2','M2');
    INSERT INTO combos(id,name,slug,public_model_id,mode) VALUES ('c1','C1','c1','c1','fallback');
    INSERT INTO combo_members(id,combo_id,model_id,position) VALUES ('cm1','c1','m1',0),('cm2','c1','m2',1);
  `);
}

function insertState(raw: Database.Database,memberId: string,modelId: string): void {
  raw.prepare(`INSERT INTO combo_adaptive_states(combo_id,member_id,model_id,workload,generation,consecutive_slow_count)
    SELECT id,?,?,?,slow_response_generation,2 FROM combos WHERE id='c1'`).run(memberId,modelId,workload);
}

describe('adaptive combo migration', () => {
  it('bootstraps bounded workload state and enforces member identity with foreign keys', () => {
    const raw = new Database(':memory:');
    try {
      runMigrations(raw,logger,migrationsDir,CURRENT_SCHEMA_VERSION);
      seed(raw);
      const defaults = raw.prepare('SELECT fallback_on_total_timeout total_timeout, slow_response_fallback_enabled enabled, slow_response_threshold_seconds threshold, slow_response_max_count max_count, slow_response_generation generation, max_request_duration_seconds duration FROM combos WHERE id=?').get('c1');
      expect(defaults).toEqual({total_timeout:1,enabled:1,threshold:60,max_count:3,generation:1,duration:null});
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name='combo_member_slow_states'").get()).toBeUndefined();
      expect(raw.prepare('SELECT version FROM schema_migrations WHERE version=15').get()).toEqual({version:15});
      insertState(raw,'cm1','m1');
      insertState(raw,'cm2','m2');
      expect(() => insertState(raw,'cm1','m2')).toThrow();
      expect(() => insertState(raw,'missing','m1')).toThrow(/FOREIGN KEY/);
      expect(() => raw.exec("UPDATE combo_adaptive_states SET workload='arbitrary-prompt-hash'")).toThrow(/CHECK/);
      expect(() => raw.exec('UPDATE combos SET max_request_duration_seconds=3601')).toThrow(/CHECK/);
      raw.exec('UPDATE combos SET max_request_duration_seconds=3600');
      raw.exec("DELETE FROM combo_members WHERE id='cm1'");
      expect(raw.prepare('SELECT model_id FROM combo_adaptive_states').all()).toEqual([{model_id:'m2'}]);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {raw.close();}
  });

  it('preserves 0012 timeout preference and 0014 slow configuration, but resets old evidence at 0015', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'latedev-adaptive-upgrade-'));
    const raw = new Database(':memory:');
    try {
      runMigrations(raw,logger,prefix(dir,11),11);
      seed(raw);
      raw.exec("UPDATE combos SET fallback_on_connect_timeout=0 WHERE id='c1'");
      runMigrations(raw,logger,prefix(dir,14),14);
      raw.exec(`
        UPDATE combos SET slow_response_threshold_seconds=42,slow_response_max_count=5,slow_response_generation=8,config_version=12;
        INSERT INTO combo_member_slow_states(combo_id,model_id,consecutive_slow_count,cooldown_until_ms,probe_lease_until_ms)
        VALUES ('c1','m1',4,60000,80000);
      `);
      runMigrations(raw,logger,migrationsDir,CURRENT_SCHEMA_VERSION);
      expect(raw.prepare(`SELECT fallback_on_total_timeout total_timeout,slow_response_threshold_seconds threshold,
        slow_response_max_count max_count,slow_response_generation generation,config_version,max_request_duration_seconds duration
        FROM combos WHERE id='c1'`).get()).toEqual({total_timeout:0,threshold:42,max_count:5,generation:9,config_version:12,duration:null});
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name='combo_member_slow_states'").get()).toBeUndefined();
      expect(raw.prepare('SELECT * FROM combo_adaptive_states').all()).toEqual([]);
      expect(raw.prepare('SELECT id FROM combo_members ORDER BY position').all()).toEqual([{id:'cm1'},{id:'cm2'}]);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      runMigrations(raw,logger,migrationsDir,CURRENT_SCHEMA_VERSION);
      expect(raw.prepare('SELECT slow_response_generation AS generation FROM combos').get()).toEqual({generation:9});
    } finally {raw.close();fs.rmSync(dir,{recursive:true,force:true});}
  });

  it('invalidates evidence for provider/model configuration edits but not health, labels or no-op changes', () => {
    const raw = new Database(':memory:');
    try {
      runMigrations(raw,logger,migrationsDir,CURRENT_SCHEMA_VERSION);
      seed(raw);
      const generation = () => (raw.prepare("SELECT slow_response_generation g FROM combos WHERE id='c1'").get() as {g:number}).g;
      const seedEvidence = () => {
        insertState(raw,'cm1','m1');
        raw.prepare("INSERT INTO combo_adaptive_exploration(combo_id,workload,generation,next_due_ms) VALUES ('c1',?,?,1000)").run(workload,generation());
      };
      seedEvidence();
      raw.exec("UPDATE providers SET health_state='degraded',name='new',updated_at='now',base_url=base_url");
      raw.exec("UPDATE models SET display_name='new',last_seen_upstream_at='now',updated_at='now'");
      expect(generation()).toBe(1);
      expect(raw.prepare('SELECT * FROM combo_adaptive_states').all()).toHaveLength(1);
      raw.exec("UPDATE providers SET base_url='https://new.example.test'");
      expect(generation()).toBe(2);
      expect(raw.prepare('SELECT * FROM combo_adaptive_states').all()).toEqual([]);
      expect(raw.prepare('SELECT * FROM combo_adaptive_exploration').all()).toEqual([]);
      seedEvidence();
      raw.exec("UPDATE models SET capabilities_json='{\"tools\":true}' WHERE id='m1'");
      expect(generation()).toBe(3);
      expect(raw.prepare('SELECT * FROM combo_adaptive_states').all()).toEqual([]);
      expect(raw.prepare('SELECT * FROM combo_adaptive_exploration').all()).toEqual([]);
    } finally {raw.close();}
  });
});
