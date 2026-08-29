// tests/unit/config.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, setConfigMasterKey, resetConfigForTests } from '@server/config/index';
import { isMasterKeyConfigured } from '@server/auth/crypto';

describe('config master key', () => {
  const tmpDir = path.join(os.tmpdir(), `latedev-config-test-${Date.now()}`);
  beforeEach(() => {
    resetConfigForTests();
    try { fs.unlinkSync(path.join(tmpDir, 'master.key')); } catch { /* */ }
    delete process.env.LATEDEV_MASTER_KEY;
    process.env.LATEDEV_DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
  });

  it('reads master.key file when env absent', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'master.key'), 'a'.repeat(32), 'utf8');
    delete process.env.LATEDEV_MASTER_KEY;
    const cfg = loadConfig(process.env, []);
    expect(cfg.masterKey).toBe('a'.repeat(32));
  });

  it('env takes precedence over master.key file', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'master.key'), 'wrong-key', 'utf8');
    process.env.LATEDEV_MASTER_KEY = 'right-key-32-chars-long!';
    const cfg = loadConfig(process.env, []);
    expect(cfg.masterKey).toBe('right-key-32-chars-long!');
  });

  it('returns null when neither env nor file exists', () => {
    const cfg = loadConfig(process.env, []);
    expect(cfg.masterKey).toBeNull();
  });

  it('empty-string LATEDEV_MASTER_KEY does not shadow master.key file (docker-compose case)', () => {
    // docker-compose `LATEDEV_MASTER_KEY: ${LATEDEV_MASTER_KEY:-}` injects an EMPTY
    // STRING (not undefined) when the host var is unset. That empty string used to
    // win over the master.key file via `??`, breaking all provider decrypts after a
    // container restart with "Gateway error".
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'master.key'), 'b'.repeat(32), 'utf8');
    process.env.LATEDEV_MASTER_KEY = '';
    const cfg = loadConfig(process.env, []);
    expect(cfg.masterKey).toBe('b'.repeat(32));
    expect(isMasterKeyConfigured()).toBe(true);
  });

  it('empty-string env vars fall back to schema defaults', () => {
    process.env.LATEDEV_LOG_LEVEL = '';
    const cfg = loadConfig(process.env, []);
    expect(cfg.logLevel).toBe('info');
    delete process.env.LATEDEV_LOG_LEVEL;
  });

  it('setConfigMasterKey updates cached config for crypto reads', () => {
    resetConfigForTests();
    loadConfig(process.env, []);
    setConfigMasterKey('new-key-32-chars-long!!');
    expect(isMasterKeyConfigured()).toBe(true);
  });
});
