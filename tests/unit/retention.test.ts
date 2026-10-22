import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getRawDb, openDb } from '../../src/server/db';
import { runDailyRequestHistoryCleanup } from '../../src/server/maintenance/retention';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-retention-'));
  openDb(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('daily request history cleanup', () => {
  it('removes all prior UTC-day requests and attempts but keeps today and daily stats', () => {
    const db = getRawDb();
    const insertRequest = db.prepare(`INSERT INTO requests
      (id, created_at, client_ip, protocol, endpoint, requested_model, resolved_target_kind, streaming, http_status, success)
      VALUES (?, ?, '127.0.0.1', 'openai', '/v1/chat/completions', 'model', 'model', 0, 200, 1)`);
    insertRequest.run('old', '2026-10-21T23:59:59.000Z');
    insertRequest.run('today', '2026-10-22T00:00:00.000Z');
    db.prepare(`INSERT INTO request_attempts
      (id, request_id, attempt_number, provider_id, model_id, started_at, success, selection_reason)
      VALUES ('old-attempt', 'old', 1, 'provider', 'model', '2026-10-21T23:59:59.000Z', 1, 'test')`).run();
    db.prepare(`INSERT INTO daily_model_stats (day, model_id, requests) VALUES ('2026-10-21', 'model', 1)`).run();

    const result = runDailyRequestHistoryCleanup(new Date('2026-10-22T12:00:00.000Z'));

    expect(result.deletedRequests).toBe(1);
    expect(result.deletedAttempts).toBe(1);
    expect(db.prepare('SELECT id FROM requests ORDER BY id').all()).toEqual([{ id: 'today' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM request_attempts').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_model_stats').get()).toEqual({ count: 1 });
  });
});
