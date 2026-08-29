# Review package: Task 1 — Config layer: master.key file fallback + `setConfigMasterKey()`

**Scope:** `src/server/config/index.ts` (modified) + `tests/unit/config.test.ts` (created).
**Not a git repo** — this package contains the current state of the changed files (final content, post-change).

## Files changed (final state)

### `src/server/config/index.ts`

Current full content (Task 1 modified: added `fs` import line 4, `readMasterKeyFile` lines 35-45, `masterKey: parsed.LATEDEV_MASTER_KEY ?? readMasterKeyFile(dataDir)` line 65, `setConfigMasterKey` lines 79-84):

```typescript
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EnvSchema = z.object({
  LATEDEV_HOST: z.string().default('0.0.0.0'),
  LATEDEV_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  LATEDEV_DATA_DIR: z.string().optional(),
  LATEDEV_MASTER_KEY: z.string().optional(),
  LATEDEV_TRUST_PROXY: z.coerce.number().int().min(0).max(8).default(0),
  LATEDEV_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LATEDEV_DB_URL: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  masterKey: string | null;
  trustProxyHops: number;
  logLevel: string;
  env: 'development' | 'production' | 'test';
  isContainer: boolean;
  appVersion: string;
}

let cached: RuntimeConfig | null = null;

function readMasterKeyFile(dataDir: string): string | null {
  try {
    const p = path.join(dataDir, 'master.key');
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  } catch {
    /* ignore unreadable file — treat as absent */
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): RuntimeConfig {
  if (cached) return cached;

  const parsed = EnvSchema.parse(env);
  const cliArgs = parseArgs(argv);
  const dataDir =
    cliArgs.dataDir ??
    parsed.LATEDEV_DATA_DIR ??
    (parsed.NODE_ENV === 'test' ? path.resolve('../.tmp/test-data') : path.resolve(os.homedir(), '.latedev-router'));

  const isContainer = Boolean(env.LATEDEV_DATA_DIR?.startsWith('/data') || process.env.CONTAINER === '1');
  const dbFile = parsed.LATEDEV_DB_URL ?? path.join(dataDir, 'data.sqlite');

  cached = {
    host: cliArgs.host ?? parsed.LATEDEV_HOST,
    port: cliArgs.port ?? parsed.LATEDEV_PORT,
    dataDir,
    dbFile,
    masterKey: parsed.LATEDEV_MASTER_KEY ?? readMasterKeyFile(dataDir),
    trustProxyHops: parsed.LATEDEV_TRUST_PROXY,
    logLevel: parsed.LATEDEV_LOG_LEVEL,
    env: parsed.NODE_ENV,
    isContainer,
    appVersion: process.env.npm_package_version ?? '0.1.0',
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}

export function setConfigMasterKey(key: string): void {
  process.env.LATEDEV_MASTER_KEY = key; // future loadConfig reads pick it up
  if (cached) {
    cached.masterKey = key;
  }
}

function parseArgs(argv: string[]): { host?: string; port?: number; dataDir?: string } {
  const out: { host?: string; port?: number; dataDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' && argv[i + 1]) {
      out.host = argv[++i];
    } else if (a?.startsWith('--host=')) {
      out.host = a.split('=')[1];
    } else if (a === '--port' && argv[i + 1]) {
      out.port = Number(argv[++i]);
    } else if (a?.startsWith('--port=')) {
      out.port = Number(a.split('=')[1]);
    } else if (a === '--data-dir' && argv[i + 1]) {
      out.dataDir = argv[++i];
    } else if (a?.startsWith('--data-dir=')) {
      out.dataDir = a.split('=')[1];
    }
  }
  return out;
}
```

### `tests/unit/config.test.ts` (created, verbatim from plan)

```typescript
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

  it('setConfigMasterKey updates cached config for crypto reads', () => {
    resetConfigForTests();
    loadConfig(process.env, []);
    setConfigMasterKey('new-key-32-chars-long!!');
    expect(isMasterKeyConfigured()).toBe(true);
  });
});
```

## Test evidence (from implementer report)

- Pre-implementation: `vitest run tests/unit/config.test.ts` → 2 PASS / 2 FAIL (predicted failures: file fallback not implemented; `setConfigMasterKey` missing)
- Post-implementation: 4 PASS / 0 FAIL
- Full suite: 12 files / 52 tests PASS
- `pnpm typecheck` clean; `eslint` on both files clean

## Global constraints binding this task (from plan)

- Config layer: `loadConfig()` master-key resolution order = env → `<dataDir>/master.key` file → null
- `setConfigMasterKey(key: string): void` — updates `cached.masterKey` (and env for future reads); fixes pre-existing cache bug
- Master key never stored in SQLite / never returned by UI-API / never logged
- TypeScript strict, pnpm