# Task 2 Report: Setup — auto-gen master key + file write + cache fix

## 1. Files created/modified

### Created: `tests/integration/master-key.test.ts`

Final content (verbatim from the plan):

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-mk-test-${Date.now()}`);
// NO LATEDEV_MASTER_KEY set — ask setup to auto-gen
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
// Ensure key env is absent
delete process.env.LATEDEV_MASTER_KEY;

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // Setup — no LATEDEV_MASTER_KEY set, so the handler must auto-generate.
  const res = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  if (!res.ok) throw new Error(`setup ${res.status}`);
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('auto-generated master key', () => {
  it('setup created master.key file with a 44-char base64 key', () => {
    const keyPath = path.join(dataDir, 'master.key');
    expect(fs.existsSync(keyPath)).toBe(true);
    const content = fs.readFileSync(keyPath, 'utf8').trim();
    expect(content.length).toBe(44); // 32 bytes base64 produces 44 chars
  });

  it('provider creation succeeds in same process (regression for config cache bug)', async () => {
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(loginRes.status).toBe(200);
    const cookies = loginRes.headers.get('set-cookie') ?? '';
    // This returned 503 before the setConfigMasterKey cache fix.
    const provRes = await fetch(`${baseUrl}/api/admin/providers`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({
        name: 'test', slug: 'test', type: 'openai',
        baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test',
        enabled: true, totalTimeoutMs: 5000,
      }),
    });
    expect(provRes.status).toBe(200);
  });
});
```

### Modified: `src/server/routes/admin/setup.ts`

**Diff (original → new):**

Top of file — added 4 imports:
```diff
+ import crypto from 'node:crypto';
+ import fs from 'node:fs';
+ import path from 'node:path';
+ import { loadConfig, setConfigMasterKey } from '../../config/index';
```

POST handler — replaced the old `if (body.setupMasterKey)` block:
```diff
-    if (body.setupMasterKey) {
-      // Stash the master key for the running process (in-memory only).
-      process.env.LATEDEV_MASTER_KEY = body.setupMasterKey;
-      updateSettings({ masterKeyConfigured: true });
-    }
+    // Determine effective master key
+    let effectiveKey = process.env.LATEDEV_MASTER_KEY;
+    if (!effectiveKey) {
+      if (body.setupMasterKey) {
+        effectiveKey = body.setupMasterKey;
+      } else {
+        const cfg = loadConfig();
+        const keyPath = path.join(cfg.dataDir, 'master.key');
+        if (fs.existsSync(keyPath)) {
+          effectiveKey = fs.readFileSync(keyPath, 'utf8').trim();
+        } else {
+          // Auto-generate
+          effectiveKey = crypto.randomBytes(32).toString('base64');
+          fs.mkdirSync(cfg.dataDir, { recursive: true });
+          fs.writeFileSync(keyPath, effectiveKey, { mode: 0o600, encoding: 'utf8' });
+        }
+      }
+      // Set into running config (fixes the cache bug)
+      setConfigMasterKey(effectiveKey);
+      process.env.LATEDEV_MASTER_KEY = effectiveKey;
+      updateSettings({ masterKeyConfigured: true });
+    }
```

## 2. Test commands + output

### Pre-implementation (red phase):
```
$ pnpm exec vitest run tests/integration/master-key.test.ts
PASS (0) FAIL (2)
  1. … setup created master.key file → AssertionError: expected false to be true
  2. … provider creation succeeds → AssertionError: expected 503 to be 200
```

### Post-implementation (green phase):
```
$ pnpm exec vitest run tests/integration/master-key.test.ts
PASS (2) FAIL (0)
```

### Full suite:
```
$ pnpm test
Test Files  13 passed (13)
      Tests  54 passed (54)
  Duration  3.66s
```

### Typecheck + lint:
```
$ pnpm typecheck  →  exit 0
$ pnpm lint       →  ESLint: No issues found
```

## 3. Deviations from the plan

None. The implementation follows the plan verbatim — exact imports, exact replacement block, exact test file content.

## 4. Short self-review

- **TDD cycle**: Red (2 expected failures) → Green (2 passes) → Full suite (54/54 pass). Clean cycle.
- **The fix**: The old code only handled `body.setupMasterKey` and stashed it in `process.env` *after* config was cached, so provider creation (which reads `loadConfig().masterKey`) got `null` and returned 503. The new code uses `setConfigMasterKey()` to update the cached config object directly, then also sets `process.env` for subsequent `loadConfig()` calls. It also handles the case where neither env nor body provides a key by auto-generating a 32-byte base64 key and writing it to `master.key`.
- **Security**: The file is written with mode `0o600` (owner read/write only). The key is 32 bytes of random data base64-encoded (44 chars), matching the existing pattern.
- **Edge cases**: Existing `master.key` file is reused; env var takes precedence over both body and file; if `LATEDEV_MASTER_KEY` is already set, the whole block is skipped (no re-generation, no overwrite).