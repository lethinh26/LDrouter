// Real pre-removal database for migration/restore regression tests. No live DB is touched.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runMigrations } from '../../src/server/db/migrate';

export const LEGACY_DAY = '2026-01-15';
export const LEGACY_COMPACT_DAY = '2026-01-14';
export const LEGACY_KEY = 'ld-fixture-legacy-only';
export const MIXED_KEY = 'ld-fixture-mixed';
export const ALL_KEY = 'ld-fixture-all';
export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
export const MIGRATION_LOG = { info() {}, warn() {} } as never;

export function createLegacyDatabase(dir: string): Database.Database {
  const migrations = path.join(dir, 'migrations-before-14');
  fs.mkdirSync(migrations, { recursive: true });
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 13) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(migrations, file));
    }
  }
  const raw = new Database(path.join(dir, 'legacy.sqlite'));
  try {
    runMigrations(raw, MIGRATION_LOG, migrations, 13);
    // Old releases never updated schema_version; real pre-0014 backups declare zero.
    raw.exec(`
      UPDATE app_settings SET schema_version=0, setup_complete=1 WHERE id=1;
      INSERT INTO admin_account (id,username,password_hash) VALUES ('fixture-admin','admin','fixture-only');
      INSERT INTO providers (id,name,slug,type,base_url,encrypted_api_key,api_key_nonce,connect_timeout_ms,first_token_timeout_ms)
      VALUES ('p-openai','OpenAI compatible','compatible','openai','https://example.test/openai','encrypted-openai','nonce-openai',12345,23456),
             ('p-anthropic','Anthropic compatible','anthropic','anthropic','https://example.test/anthropic','encrypted-anthropic','nonce-anthropic',34567,45678),
             ('p-retired-a','Retired A','retired-a','codex','https://example.test/retired-a',NULL,NULL,60000,60000),
             ('p-retired-b','Retired B','retired-b','qoder','https://example.test/retired-b',NULL,NULL,60000,60000);
      INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name,capabilities_json)
      VALUES ('m-openai','p-openai','codex-compatible','compatible/codex-compatible','Supported model','{"chat":true}'),
             ('m-anthropic','p-anthropic','qoder-compatible','anthropic/qoder-compatible','Supported model','{"chat":true}'),
             ('m-retired-a','p-retired-a','old-a','retired-a/old-a','Retired A','{}'),
             ('m-retired-b','p-retired-b','old-b','retired-b/old-b','Retired B','{}');
      INSERT INTO codex_accounts (id,provider_id,encrypted_access_token,access_token_nonce,encrypted_refresh_token,refresh_token_nonce,token_expires_at)
      VALUES ('account-a','p-retired-a','fixture-encrypted-access','nonce','fixture-encrypted-refresh','nonce','2030-01-01T00:00:00Z');
      INSERT INTO qoder_accounts (id,provider_id,qoder_user_id,machine_id,encrypted_pat,pat_nonce,encrypted_job_token,job_token_nonce,job_token_expires_at)
      VALUES ('account-b','p-retired-b','fixture-user','fixture-machine','fixture-encrypted-pat','nonce','fixture-encrypted-job','nonce','2030-01-01T00:00:00Z');
      INSERT INTO combos (id,name,slug,public_model_id,mode,enabled,config_version)
      VALUES ('mixed','Mixed','mixed','combo/mixed','fallback',1,4),
             ('empty','Newly empty','empty','combo/empty','fallback',1,7),
             ('untouched','Untouched','untouched','combo/untouched','fallback',1,3),
             ('disabled','Disabled','disabled','combo/disabled','fallback',0,2);
      INSERT INTO combo_members (id,combo_id,model_id,position,enabled)
      VALUES ('member-a','mixed','m-retired-a',0,1),
             ('member-openai','mixed','m-openai',1,1),
             ('member-b','mixed','m-retired-b',2,1),
             ('member-anthropic','mixed','m-anthropic',3,1),
             ('member-empty','empty','m-retired-b',0,1),
             ('member-untouched','untouched','m-anthropic',0,1),
             ('member-disabled-old','disabled','m-retired-a',0,1),
             ('member-disabled-keep','disabled','m-openai',1,0);
      INSERT INTO combo_member_slow_states (combo_id,model_id,consecutive_slow_count,last_outcome)
      VALUES ('mixed','m-retired-a',5,'slow'),('mixed','m-openai',2,'slow'),
             ('mixed','m-anthropic',1,'fast'),('empty','m-retired-b',3,'slow'),
             ('untouched','m-anthropic',4,'slow');
      INSERT INTO model_aliases (id,alias,target_kind,target_id,enabled,config_version)
      VALUES ('alias-retired','retired-direct','model','m-retired-a',1,3),
             ('alias-mixed','mixed-alias','combo','mixed',1,5),
             ('alias-empty','empty-alias','combo','empty',1,6),
             ('alias-keep','keep-alias','model','m-openai',1,2);
    `);
    const insertKey = raw.prepare('INSERT INTO api_keys (id,name,key_prefix,key_digest,allow_all_models) VALUES (?,?,?,?,?)');
    for (const [id, secret, all] of [['key-legacy', LEGACY_KEY, 0], ['key-mixed', MIXED_KEY, 0], ['key-all', ALL_KEY, 1]] as const) {
      insertKey.run(id, id, secret.slice(0, 8), crypto.createHash('sha256').update(secret).digest('hex'), all);
    }
    raw.exec(`
      INSERT INTO api_key_model_permissions (id,api_key_id,target_kind,target_id)
      VALUES ('perm-legacy-model','key-legacy','model','m-retired-b'),
             ('perm-legacy-alias','key-legacy','alias','alias-retired'),
             ('perm-mixed-legacy','key-mixed','model','m-retired-a'),
             ('perm-mixed-keep','key-mixed','model','m-openai'),
             ('perm-mixed-combo','key-mixed','combo','mixed'),
             ('perm-mixed-empty','key-mixed','combo','empty'),
             ('perm-mixed-alias','key-mixed','alias','alias-keep');
      INSERT INTO response_cache (id,cache_key,target_kind,target_id,protocol,response_json,expires_at)
      VALUES ('cache-old','cache-old','model','m-retired-b','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-combo','cache-combo','combo','mixed','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-empty','cache-empty','combo','empty','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-alias-old','cache-alias-old','alias','alias-retired','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-alias-combo','cache-alias-combo','alias','alias-mixed','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-alias-empty','cache-alias-empty','alias','alias-empty','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-keep','cache-keep','model','m-openai','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-alias-keep','cache-alias-keep','alias','alias-keep','openai','{}','2030-01-01T00:00:00Z'),
             ('cache-untouched','cache-untouched','combo','untouched','anthropic','{}','2030-01-01T00:00:00Z');
      INSERT INTO requests (id,created_at,api_key_id,key_prefix_snapshot,client_ip,protocol,endpoint,requested_model,resolved_target_kind,resolved_target_id,final_model_id,streaming,http_status,success,total_latency_ms,ttft_ms,input_tokens,output_tokens,total_tokens,attempts_count)
      VALUES ('request-old-a','${LEGACY_DAY}T12:00:00.000Z','key-legacy','ld-fixtu','127.0.0.1','openai','/v1/chat/completions','retired-a/old-a','model','m-retired-a','m-retired-a',0,200,1,100,20,12,3,15,1),
             ('request-old-b','${LEGACY_DAY}T12:01:00.000Z','key-mixed','ld-fixtu','127.0.0.1','openai','/v1/chat/completions','retired-b/old-b','model','m-retired-b','m-retired-b',0,200,1,200,30,20,5,25,1),
             ('request-current','${LEGACY_DAY}T12:02:00.000Z','key-mixed','ld-fixtu','127.0.0.1','anthropic','/v1/messages','combo/mixed','combo','mixed','m-anthropic',1,200,1,300,40,30,10,40,2);
      INSERT INTO request_attempts (id,request_id,attempt_number,provider_id,model_id,started_at,status_code,success,latency_ms,ttft_ms,input_tokens,output_tokens,selection_reason,failure_reason,codex_account_id,qoder_account_id)
      VALUES ('attempt-old-a','request-old-a',1,'p-retired-a','m-retired-a','${LEGACY_DAY}T12:00:00.000Z',200,1,100,20,12,3,'primary',NULL,'account-a',NULL),
             ('attempt-old-b','request-old-b',1,'p-retired-b','m-retired-b','${LEGACY_DAY}T12:01:00.000Z',200,1,200,30,20,5,'primary',NULL,NULL,'account-b'),
             ('attempt-failed','request-current',1,'p-retired-a','m-retired-a','${LEGACY_DAY}T12:02:00.000Z',503,0,50,NULL,0,0,'primary','upstream_5xx','account-a',NULL),
             ('attempt-current','request-current',2,'p-anthropic','m-anthropic','${LEGACY_DAY}T12:02:00.050Z',200,1,250,40,30,10,'fallback',NULL,NULL,NULL);
      INSERT INTO daily_model_stats (day,model_id,requests,successful_requests,input_tokens,output_tokens,latency_success_sum_ms,latency_success_count)
      VALUES ('${LEGACY_COMPACT_DAY}','m-retired-a',5,5,50,10,500,5),
             ('${LEGACY_DAY}','m-retired-a',1,1,12,3,100,1),
             ('${LEGACY_DAY}','m-retired-b',1,1,20,5,200,1),
             ('${LEGACY_DAY}','m-anthropic',1,1,30,10,300,1);
      INSERT INTO daily_provider_stats (day,provider_id,attempts,successful_attempts,failed_attempts,input_tokens,output_tokens)
      VALUES ('${LEGACY_COMPACT_DAY}','p-retired-a',5,5,0,50,10),
             ('${LEGACY_DAY}','p-retired-a',2,1,1,12,3),
             ('${LEGACY_DAY}','p-retired-b',1,1,0,20,5),
             ('${LEGACY_DAY}','p-anthropic',1,1,0,30,10);
      INSERT INTO daily_api_key_stats (day,api_key_id,requests,successful_requests,input_tokens,output_tokens,total_tokens)
      VALUES ('${LEGACY_COMPACT_DAY}','key-legacy',5,5,50,10,60),
             ('${LEGACY_DAY}','key-legacy',1,1,12,3,15),
             ('${LEGACY_DAY}','key-mixed',2,2,50,15,65);
      INSERT INTO audit_logs (id,action,success,target_type,target_id,target_name) VALUES ('historical-audit','provider.create',1,'provider','p-retired-a','Retired A');
      INSERT INTO usage_daily (day,api_key_id,input_tokens,output_tokens,total_tokens) VALUES ('${LEGACY_DAY}','key-legacy',12,3,15);
      INSERT INTO usage_monthly (month,api_key_id,input_tokens,output_tokens,total_tokens) VALUES ('2026-01','key-legacy',62,13,75);
    `);
    return raw;
  } catch (error) {
    raw.close();
    throw error;
  }
}
