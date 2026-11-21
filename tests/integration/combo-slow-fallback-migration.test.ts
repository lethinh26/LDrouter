import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/server/db/migrate';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const logger = { info() {}, warn() {} } as never;

describe('combo slow-response fallback migration', () => {
  it('adds safe defaults and persistent per-member state on an empty database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-combo-slow-migration-'));
    const raw = new Database(path.join(dir, 'test.db'));
    try {
      raw.pragma('foreign_keys = ON');
      runMigrations(raw, logger, migrationsDir);

      const columns = raw.prepare("SELECT name FROM pragma_table_info('combos')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'fallback_on_total_timeout', 'slow_response_fallback_enabled', 'slow_response_threshold_seconds', 'slow_response_max_count', 'slow_response_generation',
      ]));
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combo_member_slow_states'").get()).toBeTruthy();
      expect(raw.prepare("SELECT version FROM schema_migrations WHERE version=12").get()).toEqual({ version: 12 });

      raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('p1','P1','p1','openai','https://example.test')").run();
      raw.prepare("INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('m1','p1','m1','p1/m1','M1'), ('m2','p1','m2','p1/m2','M2')").run();
      raw.prepare("INSERT INTO combos (id,name,slug,public_model_id,mode) VALUES ('c1','C1','c1','c1','fallback')").run();
      raw.prepare("INSERT INTO combo_members (id,combo_id,model_id,position) VALUES ('cm1','c1','m1',0), ('cm2','c1','m2',1)").run();
      const defaults = raw.prepare('SELECT fallback_on_total_timeout total_timeout, slow_response_fallback_enabled enabled, slow_response_threshold_seconds threshold, slow_response_max_count max_count, slow_response_generation generation FROM combos WHERE id=?').get('c1');
      expect(defaults).toEqual({ total_timeout: 1, enabled: 1, threshold: 60, max_count: 3, generation: 1 });
      raw.prepare("INSERT INTO combo_member_slow_states (combo_id,model_id,consecutive_slow_count) VALUES ('c1','m1',2), ('c1','m2',1)").run();
      expect(raw.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => raw.prepare("INSERT INTO combo_member_slow_states (combo_id,model_id) VALUES ('c1','missing')").run()).toThrow(/FOREIGN KEY constraint failed/);
      raw.prepare("DELETE FROM combo_members WHERE id='cm1'").run();
      expect(raw.prepare('SELECT model_id FROM combo_member_slow_states WHERE combo_id=? ORDER BY model_id').all('c1')).toEqual([{ model_id: 'm2' }]);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the prior connect-timeout fallback preference when upgrading existing combos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-combo-slow-upgrade-'));
    const beforeTwelveDir = path.join(dir, 'migrations-before-12');
    fs.mkdirSync(beforeTwelveDir);
    const beforeTwelveFiles = fs.readdirSync(migrationsDir).filter((file) => {
      const version = Number.parseInt(file.split('_')[0] ?? '0', 10);
      return file.endsWith('.sql') && version < 12;
    });
    for (const file of beforeTwelveFiles) fs.copyFileSync(path.join(migrationsDir, file), path.join(beforeTwelveDir, file));
    const raw = new Database(path.join(dir, 'upgrade.db'));
    try {
      raw.pragma('foreign_keys = ON');
      runMigrations(raw, logger, beforeTwelveDir);
      raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('p1','P1','p1','openai','https://example.test')").run();
      raw.prepare("INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('m1','p1','m1','p1/m1','M1')").run();
      raw.prepare("INSERT INTO combos (id,name,slug,public_model_id,mode,fallback_on_connect_timeout) VALUES ('c1','C1','c1','c1','fallback',0)").run();

      runMigrations(raw, logger, migrationsDir);

      expect(raw.prepare('SELECT fallback_on_total_timeout FROM combos WHERE id=?').get('c1')).toEqual({ fallback_on_total_timeout: 0 });
      raw.prepare("INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('m2','p1','m2','p1/m2','M2')").run();
      raw.prepare("INSERT INTO combo_members (id,combo_id,model_id,position) VALUES ('cm1','c1','m1',0), ('cm2','c1','m2',1)").run();
      raw.prepare("INSERT INTO combo_member_slow_states (combo_id,model_id,consecutive_slow_count) VALUES ('c1','m1',2), ('c1','m2',1)").run();
      expect(raw.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      raw.prepare("DELETE FROM combo_members WHERE id='cm1'").run();
      expect(raw.prepare('SELECT model_id FROM combo_member_slow_states WHERE combo_id=? ORDER BY model_id').all('c1')).toEqual([{ model_id: 'm2' }]);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
