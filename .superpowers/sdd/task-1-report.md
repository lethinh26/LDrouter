# Task 1 Report — Config layer: master.key file fallback + `setConfigMasterKey()`

**Status:** DONE
**Date:** 2026-08-28
**Plan section:** `docs/superpowers/plans/2026-08-28-master-key-encrypted-apikeys-logo.md` — Task 1 (lines 78–197)

## Summary

`loadConfig()` now falls back to reading `<dataDir>/master.key` when `LATEDEV_MASTER_KEY` env is absent, and a new `setConfigMasterKey(key)` export fixes the pre-existing config-cache bug (previously, writing the env var after the first `loadConfig()` call had no effect because the `cached` RuntimeConfig is frozen for the process lifetime).

Developed test-first (TDD): the 4-test suite was written and verified to fail, then the implementation was added and verified to pass.

## 1. Files created / modified

| Path | Action |
|---|---|
| `tests/unit/config.test.ts` | **Created** (new unit test, verbatim from plan) |
| `src/server/config/index.ts` | **Modified** (fs import, `readMasterKeyFile` helper, masterKey fallback, `setConfigMasterKey` export) |

### Final content of `tests/unit/config.test.ts`

```typescript
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

  it('setConfigMasterKey updates cached config for crypto reads', () => {
    resetConfigForTests();
    loadConfig(process.env, []);
    setConfigMasterKey('new-key-32-chars-long!!');
    expect(isMasterKeyConfigured()).toBe(true);
  });
});
```

### Diff to `src/server/config/index.ts`

```diff
 import { z } from 'zod';
 import path from 'node:path';
 import os from 'node:os';
+import fs from 'node:fs';

 // EnvSchema unchanged ...

 let cached: RuntimeConfig | null = null;

+function readMasterKeyFile(dataDir: string): string | null {
+  try {
+    const p = path.join(dataDir, 'master.key');
+    if (fs.existsSync(p)) {
+      return fs.readFileSync(p, 'utf8').trim();
+    }
+  } catch {
+    /* ignore unreadable file — treat as absent */
+  }
+  return null;
+}
+
 export function loadConfig(...): RuntimeConfig {
   ...
   cached = {
     ...
-    masterKey: parsed.LATEDEV_MASTER_KEY ?? null,
+    masterKey: parsed.LATEDEV_MASTER_KEY ?? readMasterKeyFile(dataDir),
     ...
   };
   return cached;
 }

 export function resetConfigForTests(): void {
   cached = null;
 }
+
+export function setConfigMasterKey(key: string): void {
+  process.env.LATEDEV_MASTER_KEY = key; // future loadConfig reads pick it up
+  if (cached) {
+    cached.masterKey = key;
+  }
+}
```

## 2. Test commands and output

### Step 2 — failing test (before implementation)

```
$ pnpm exec vitest run tests/unit/config.test.ts
PASS (2) FAIL (2)
1. config master key reads master.key file when env absent
   AssertionError: expected null to be 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
2. config master key setConfigMasterKey updates cached config for crypto reads
   TypeError: __vite_ssr_import_4__.setConfigMasterKey is not a function
```

Both failures are exactly the two predicted: file fallback unimplemented and `setConfigMasterKey` missing.

### Step 4 — passing test (after implementation)

```
$ pnpm exec vitest run tests/unit/config.test.ts
PASS (4) FAIL (0)
```

All 4 tests pass.

### Step 5 — full regression suite

```
$ pnpm test
 Test Files  12 passed (12)
      Tests  52 passed (52)
   Duration 3.74s
```

All 12 existing test files pass with no regressions. (One pre-existing `FSTDEP023` Fastify deprecation warning about `disableRequestLogging` appears in integration test output — unrelated to this change, present before.)

### Additional verification

```
$ pnpm typecheck
tsc -p tsconfig.json --noEmit     # clean, exit 0

$ npx eslint src/server/config/index.ts tests/unit/config.test.ts
ESLint: No issues found
```

## 3. Deviations from the plan

None. The implementation follows the plan's code verbatim (imports, helper, fallback expression, export signature). The plan's line references (~32, ~52) were approximate; they were located by content as instructed. No product/design decisions were needed.

## 4. Self-review

- **Interface contract satisfied:** `setConfigMasterKey(key: string): void` is exported from `@server/config/index`, sets `process.env.LATEDEV_MASTER_KEY`, and updates `cached.masterKey` when cache exists. `loadConfig()` returns `masterKey: string | null` with null only when neither env nor file exists. Later tasks can depend on this surface.
- **The four test cases cover the full contract:** file-only, env-precedence, neither (null), and the cache-fix path (`setConfigMasterKey` → `isMasterKeyConfigured()` via `loadConfig()`).
- **Concern — stale key in crypto cache:** `src/server/auth/crypto.ts` keeps its own `cachedKey` buffer; if a decryption occurred before `setConfigMasterKey`, the old buffer would persist. That is out of scope for this task (getMasterKey only throws on missing key; it never re-derives on rotation), but Task 2's setup flow should ensure encryption happens only after the key is set — worth keeping in mind for later tasks.
- **Concern — ownership of `master.key` file:** `loadConfig()` only *reads* the file; writing it is Task 2's job (`POST /api/admin/setup`). No write-permission/fsync concerns land here.
- **Minor note:** `readMasterKeyFile` swallows unreadable-file errors (per plan verbatim) — if the file exists but is unreadable, `masterKey` silently stays null. Acceptable and documented in-comment; matches "treat as absent".
- **No concerns about regressions:** the config module has no other consumers depending on the exact null-when-no-env behavior being *only* env-driven; integration/unit suites all pass.