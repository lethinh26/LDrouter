import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/server/db/migrate';
import { describe, expect, it } from 'vitest';
import { upsertDailyAggregates } from '../../src/server/backup/stats';

describe('daily aggregate upserts', () => {
  it('adds request and attempt outcomes and coalesces missing dimensions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-upsert-'));
    const db = new Database(path.join(dir, 'test.db'));
    runMigrations(db, { info() {}, warn() {} } as never, path.resolve(process.cwd(), 'migrations'));
    const request = { day: '2026-01-02', modelId: null, apiKeyId: null, success: true, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHit: false, attemptsCount: 1, latencyMs: 50, ttftMs: 10 };
    const attempt = { day: request.day, providerId: 'p', success: true, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, latencyMs: 50 };
    upsertDailyAggregates(db, request, [attempt]);
    upsertDailyAggregates(db, request, [attempt]);
    expect(db.prepare('SELECT model_id,requests FROM daily_model_stats').all()).toEqual([{ model_id: '', requests: 2 }]);
    expect(db.prepare('SELECT api_key_id,requests FROM daily_api_key_stats').all()).toEqual([{ api_key_id: '', requests: 2 }]);
    expect(db.prepare('SELECT attempts,successful_attempts FROM daily_provider_stats').get()).toEqual({ attempts: 2, successful_attempts: 2 });
    db.close();
  });
});
