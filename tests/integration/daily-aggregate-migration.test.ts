import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/server/db/migrate';

const logger = { info() {}, warn() {} } as never;

describe('daily aggregate migration', () => {
  it('backfills request and attempt aggregates once from existing logs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-stats-'));
    const migrations = path.join(dir, 'migrations');
    fs.mkdirSync(migrations);
    for (const file of fs.readdirSync(path.resolve(process.cwd(), 'migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith('0011_'))) fs.copyFileSync(path.resolve(process.cwd(), 'migrations', file), path.join(migrations, file));
    const db = new Database(path.join(dir, 'test.db'));
    try {
      runMigrations(db, logger, migrations);
      const requestInsert = db.prepare(`INSERT INTO requests (id,created_at,client_ip,protocol,endpoint,requested_model,resolved_target_kind,final_model_id,streaming,http_status,success,total_latency_ms,ttft_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,attempts_count,gateway_cache_hit) VALUES ('r','2026-01-02T12:00:00.000Z','x','openai','/v1/chat','pub','model','m',0,200,1,100,20,3,4,1,2,0,7,2,0)`);
      expect(() => requestInsert.run()).not.toThrow();
      expect((db.prepare('SELECT changes() AS n, (SELECT COUNT(*) FROM requests) AS rows').get() as { n: number; rows: number }).rows).toBe(1);
      const attemptInsert = db.prepare(`INSERT INTO request_attempts (id,request_id,attempt_number,provider_id,model_id,started_at,success,latency_ms,ttft_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,selection_reason) VALUES ('a1','r',1,'p1','m','2026-01-02T12:00:00Z',0,10,NULL,0,0,0,0,0,'fallback'),('a2','r',2,'p2','m','2026-01-02T12:00:01Z',1,90,20,3,4,1,2,0,'fallback')`);
      expect(() => attemptInsert.run()).not.toThrow();
      expect((db.prepare('SELECT COUNT(*) AS n FROM request_attempts').get() as { n: number }).n).toBe(2);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(10);
      fs.copyFileSync(path.resolve(process.cwd(), 'migrations/0011_daily_aggregate_stats.sql'), path.join(migrations, '0011_daily_aggregate_stats.sql'));
      runMigrations(db, logger, migrations);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(11);
      expect(db.prepare('SELECT * FROM daily_model_stats').all()).toMatchObject([{ day: '2026-01-02', model_id: 'm', requests: 1, successful_requests: 1, failed_requests: 0, input_tokens: 3, output_tokens: 4, fallback_requests: 1, latency_success_sum_ms: 100, latency_success_count: 1, ttft_sum_ms: 20, ttft_count: 1 }]);
      expect(db.prepare('SELECT * FROM daily_provider_stats ORDER BY provider_id').all()).toMatchObject([{ day: '2026-01-02', provider_id: 'p1', attempts: 1, failed_attempts: 1 }, { day: '2026-01-02', provider_id: 'p2', attempts: 1, successful_attempts: 1 }]);
      expect(db.prepare('SELECT * FROM daily_api_key_stats').all()).toHaveLength(1);
      runMigrations(db, logger, migrations);
      expect((db.prepare('SELECT requests FROM daily_model_stats').get() as { requests: number }).requests).toBe(1);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
