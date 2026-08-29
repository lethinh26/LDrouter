# Auto-gen Master Key + Re-readable API Keys + Brand Logo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply 3 production adjustments to the existing LateDev Router codebase: auto-generate `LATEDEV_MASTER_KEY` if absent, make API keys readable from the DB at any time (encrypt-at-rest, plus optional custom key on creation), and replace placeholder "L" branding with the real `latedev.svg` logo.

**Architecture:** 7 sequential tasks, each independently testable:
1. Config layer: file fallback + `setConfigMasterKey` (fixes existing cache bug)
2. Setup: auto-gen key, write file, invoke `setConfigMasterKey`
3. Migration 0002: add `key_secret_encrypted` / `key_secret_nonce` columns
4. API key routes: store encrypted secret, return it on list/detail, accept custom `secret` param
5. API key UI: optional custom key input + Copy/Eye actions per row
6. Logo: extract PNG, produce favicon + logo assets, wire into HTML + pages
7. Docs + integration tests

**Tech Stack:** TypeScript, Fastify, Drizzle ORM + SQLite, React + Vite + shadcn/ui, Vitest, Playwright, pngjs

**Build context:** `pnpm run build` compiles server + web separately. The migration runner resolves its dir with `path.resolve(__dirname, '../migrations')` from `src/server/db/` — which points at `src/server/migrations` (source) or `dist/server/migrations` (dist), neither of which exists. It therefore **falls into the inline v1 bootstrap every time and never applies file-based migrations**. Task 3 fixes this by resolving `../../../migrations` (reaches `<root>/migrations` from both `src/server/db/` and `dist/server/db/`). The npm `files` array already includes the root `migrations/` folder, so no copy-to-dist step is needed.

## Global Constraints

- Node.js >= 22, TypeScript strict, pnpm
- Fastify + SQLite (WAL) + Drizzle ORM
- AES-256-GCM from `src/server/auth/crypto.ts` for encrypt-at-rest (existing `encryptSecret`/`decryptSecret`)
- SHA-256 digest for API key auth (unchanged)
- Master key never stored in SQLite, never returned by UI/API, never logged
- `master.key` file in data dir, mode 0600 — not in backup, not in npm tarball
- Custom API key submitted verbatim — no prefix injection, no length rewrite
- `pngjs` as devDependency for one-off logo generation script
- Docs 07 "master key not contained in backup metadata" invariant preserved

**Test-order caveat:** vitest runs with `pool: 'forks'`, `singleFork: true` — all
integration files share one process. `tests/integration/master-key.test.ts`
deletes `LATEDEV_MASTER_KEY` at module scope; because `loadConfig()` is cached
(and `resetConfigForTests()` is only called in the unit test), ensure
`master-key.test.ts` sets its own `LATEDEV_MASTER_KEY` back is NOT done — instead
the test relies on being the only integration file that runs with the env absent.
If ordering matters, run it first (`vitest run tests/integration/master-key.test.ts`)
and confirm `pnpm test` passes as a whole; if flaky, add `process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32)` in a subsequent error to isolate. Keep it simple and manual — do not over-engineer.

---

## File Structure

```
Backend:
  src/server/config/index.ts          — master.key file fallback in loadConfig, + setConfigMasterKey()
  src/server/routes/admin/setup.ts    — auto-gen, file write, cache fix
  src/server/routes/admin/api-keys.ts — encrypted storage, list decrypt, custom secret param
  src/server/db/schema.ts             — key_secret_encrypted, key_secret_nonce columns
  src/server/db/migrate.ts            — SCHEMA_VERSION bumped to 2
  migrations/0002_source_api_key_secrets.sql  — ALTER TABLE migration

Frontend:
  src/web/app/pages/api-keys.tsx      — custom key input, Copy/Eye per row
  src/web/index.html                  — favicon → /favicon.png
  src/web/components/sidebar.tsx      — chữ "L" → <img src="/logo.png">
  src/web/app/pages/login.tsx         — same
  src/web/app/pages/setup.tsx         — same
  src/web/public/favicon.png          — generated 48px
  src/web/public/logo.png             — generated 128px

Scripts:
  scripts/generate-logo.ts            — one-off, extract PNG from latedev.svg, resize to 2 files
  scripts/generate-migrations.ts      — re-run after schema change to sync 0001 (no change needed)

Build:
  package.json                        — pngjs devDep, build:server adds migrations copy step

Tests:
  tests/integration/master-key.test.ts
  tests/integration/api-keys.test.ts
  tests/e2e/critical.spec.ts          — extend
```

---

### Task 1: Config layer — master.key file fallback + `setConfigMasterKey()`

**Files:**
- Modify: `src/server/config/index.ts`
- Test: `tests/unit/config.test.ts` (new)

**Interfaces:**
- Consumes: `loadConfig()`'s existing `masterKey: string | null` field
- Produces: `setConfigMasterKey(value: string): void` — updates `cached.masterKey` and `cached.masterKeyVersion`; `loadConfig()` reads `<dataDir>/master.key` if env absent

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/config.test.ts`
Expected: FAIL — `cfg.masterKey` is null (file fallback not implemented)

- [ ] **Step 3: Write minimal implementation in `config/index.ts`**

At the top, add `fs` to the existing imports:

```typescript
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
```

Add a helper after the `cached` declaration (line ~32):

```typescript
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
```

Modify the `masterKey` field in the `cached = { ... }` object (line ~52):

```typescript
masterKey: parsed.LATEDEV_MASTER_KEY ?? readMasterKeyFile(dataDir),
```

Add a `setConfigMasterKey` export after `resetConfigForTests`:

```typescript
export function setConfigMasterKey(key: string): void {
  process.env.LATEDEV_MASTER_KEY = key; // future loadConfig reads pick it up
  if (cached) {
    cached.masterKey = key;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/config.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Run existing tests to confirm no regression**

Run: `pnpm test`
Expected: PASS (existing tests)

---

### Task 2: Setup — auto-gen master key + file write + cache fix

**Files:**
- Modify: `src/server/routes/admin/setup.ts`
- Test: `tests/integration/master-key.test.ts` (new)

**Interfaces:**
- Consumes: `setConfigMasterKey()` from Task 1, `loadConfig()` for `dataDir`, `crypto.randomBytes`
- Produces: `POST /api/admin/setup` auto-generates key when env absent, writes `master.key`, updates running config

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/master-key.test.ts
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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/integration/master-key.test.ts`
Expected: FAIL — `master.key` not created (or provider create returns 503)

- [ ] **Step 3: Modify `setup.ts`**

At the top add imports:

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, setConfigMasterKey } from '../../config/index';
```

In the POST handler, replace the `if (body.setupMasterKey)` block with:

```typescript
// Determine effective master key
let effectiveKey = process.env.LATEDEV_MASTER_KEY;
if (!effectiveKey) {
  if (body.setupMasterKey) {
    effectiveKey = body.setupMasterKey;
  } else {
    const cfg = loadConfig();
    const keyPath = path.join(cfg.dataDir, 'master.key');
    if (fs.existsSync(keyPath)) {
      effectiveKey = fs.readFileSync(keyPath, 'utf8').trim();
    } else {
      // Auto-generate
      effectiveKey = crypto.randomBytes(32).toString('base64');
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(keyPath, effectiveKey, { mode: 0o600, encoding: 'utf8' });
    }
  }
  // Set into running config (fixes the cache bug)
  setConfigMasterKey(effectiveKey);
  process.env.LATEDEV_MASTER_KEY = effectiveKey;
  updateSettings({ masterKeyConfigured: true });
}
// Remove the old `if (body.setupMasterKey) { ... }` block
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/integration/master-key.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: PASS

---

### Task 3: Migration 0002 — add encrypted secret columns to api_keys

**Files:**
- Create: `migrations/0002_source_api_key_secrets.sql`
- Modify: `src/server/db/schema.ts`, `src/server/db/migrate.ts`

**Interfaces:**
- Consumes: existing `api_keys` table
- Produces: `key_secret_encrypted TEXT`, `key_secret_nonce TEXT` columns on `api_keys`

- [ ] **Step 1: Write migration SQL**

Create `migrations/0002_source_api_key_secrets.sql`:

```sql
-- 0002_source_api_key_secrets.sql
-- Add columns for encrypted API key secret storage.
-- Allows admin to retrieve the full key after creation (encrypted at rest).

ALTER TABLE api_keys ADD COLUMN key_secret_encrypted TEXT;
ALTER TABLE api_keys ADD COLUMN key_secret_nonce TEXT;
ALTER TABLE api_keys ADD COLUMN key_secret_version INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Update `schema.ts`**

Add to `apiKeys` table definition after `keyDigest`:

```typescript
keyDigest: text('key_digest').notNull().unique(),
keySecretEncrypted: text('key_secret_encrypted'),
keySecretNonce: text('key_secret_nonce'),
keySecretVersion: integer('key_secret_version').notNull().default(1),
```

- [ ] **Step 3: Update `migrate.ts`**

Bump `SCHEMA_VERSION`:

```typescript
const SCHEMA_VERSION = 2;
```

- [ ] **Step 4: Fix migration directory resolution in `db/index.ts`**

The current `migrationsDir` is `path.resolve(__dirname, '.././migrations')`. From
`src/server/db/` that resolves to `src/server/migrations`; from `dist/server/db/`
to `dist/server/migrations`. **Neither exists**, so `runMigrations` always hits its
fresh-schema bootstrap branch and never reads the `0002_*.sql` file. Fix by
resolving up 3 levels to the project root where `migrations/` lives:

In `src/server/db/index.ts`, replace the `runMigrations` call:

```typescript
// old:
runMigrations(raw, getLogger(), path.resolve(__dirname, '.././migrations'));

// new:
runMigrations(raw, getLogger(), path.resolve(__dirname, '../../../migrations'));
```

Both layouts resolve correctly:
- source: `src/server/db/..` → `src/server/`, `../..` → `src/`, `../../..` → `<root>/` → `<root>/migrations` ✓
- dist: `dist/server/db/..` → `dist/server/`, `../..` → `dist/`, `../../..` → `<root>/` → `<root>/migrations` ✓

The root `migrations/` folder ships in the npm package via `package.json` `"files"`. No
copy-to-`dist/migrations` step is needed.

- [ ] **Step 5: Apply migration to a scratch DB**

Proof that the file-based runner now works:

```bash
mkdir -p /tmp/latedev-mig-test && cd /tmp/latedev-mig-test
LATEDEV_DATA_DIR=/tmp/latedev-mig-test LATEDEV_PORT=0 node --import tsx/esm \
  /c/Users/lephu/OneDrive/Desktop/LateDev\ Router/scripts/migrate.ts
cd /c/Users/lephu/OneDrive/Desktop/LateDev\ Router
node -e "const D=require('better-sqlite3');const db=new D('/tmp/latedev-mig-test/data.sqlite',{readonly:true});const v=db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();console.log(v);const cols=db.prepare('PRAGMA table_info(api_keys)').all().map(r=>r.name);console.log(cols.includes('key_secret_encrypted')?'COLUMNS_OK':'COLUMNS_MISSING')"
```

Expected: `[ { version: 1, name: 'initial_schema' }, { version: 2, name: 'source_api_key_secrets' } ]` and `COLUMNS_OK`.

- [ ] **Step 6: Apply migration to the existing dev DB**

Run: `pnpm run db:migrate`
Expected: "Migrations applied." — the 0002 ALTER TABLE runs on `data-e2e/data.sqlite`.

- [ ] **Step 7: Verify dev DB has the new columns**

```bash
node -e "const D=require('better-sqlite3');const db=new D('data-e2e/data.sqlite',{readonly:true});const c=db.prepare('PRAGMA table_info(api_keys)').all().map(r=>r.name);console.log(c.includes('key_secret_encrypted')?'OK':'MISSING')"
```
Expected: "OK"

---

### Task 4: API key routes — encrypted storage + decrypt on read + custom secret

**Files:**
- Modify: `src/server/routes/admin/api-keys.ts`
- Test: `tests/integration/api-keys.test.ts` (new)

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret` from `src/server/auth/crypto.ts`; `key_secret_version` column from Task 3
- Produces: `POST /api/admin/api-keys` accepts optional `secret` body param (verbatim); `GET /api/admin/api-keys` and `GET /api/admin/api-keys/:id` return `secret: string | null` per key

- [ ] **Step 1: Write failing integration test**

```typescript
// tests/integration/api-keys.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';

const dataDir = path.join(os.tmpdir(), `latedev-ak-test-${Date.now()}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  }).then((r) => { if (!r.ok) throw new Error(`setup ${r.status}`); });
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
  });
  cookies = loginRes.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('re-readable API key secrets', () => {
  it('create → list returns same secret (decrypted from DB)', async () => {
    const createRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ name: 'test-key', allowAllModels: true }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { id: string; secret: string; name: string };
    expect(created.secret).toBeTruthy();
    const listRes = await fetch(`${baseUrl}/api/admin/api-keys`, { headers: { cookie: cookies } });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { apiKeys: Array<{ id: string; secret: string | null }> };
    const found = list.apiKeys.find((k) => k.id === created.id);
    expect(found).toBeTruthy();
    expect(found!.secret).toBe(created.secret);
  });

  it('custom secret is stored verbatim, returned on list, digest matches, ciphertext differs', async () => {
    const customSecret = 'ld-my-custom-key-1234567890';
    const createRes = await fetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ name: 'custom-key', allowAllModels: true, secret: customSecret }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { id: string; secret: string };
    expect(created.secret).toBe(customSecret);
    const { sha256Hex } = await import('../../src/server/auth/ids');
    const { getDb, schema } = await import('../../src/server/db/index');
    const row = getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, created.id)).get();
    expect(row!.keyDigest).toBe(sha256Hex(customSecret));
    expect(row!.keySecretEncrypted).toBeTruthy();
    expect(row!.keySecretEncrypted).not.toContain(customSecret);
  });

  it('key with no stored secret returns secret: null', async () => {
    const { uuid, generateApiKeySecret, sha256Hex } = await import('../../src/server/auth/ids');
    const { getDb, schema } = await import('../../src/server/db/index');
    const legacySecret = generateApiKeySecret();
    getDb().insert(schema.apiKeys).values({
      id: uuid(), name: 'legacy', keyPrefix: legacySecret.slice(0, 11),
      keyDigest: sha256Hex(legacySecret), enabled: true, allowAllModels: true,
    }).run();
    const listRes = await fetch(`${baseUrl}/api/admin/api-keys`, { headers: { cookie: cookies } });
    const list = await listRes.json() as { apiKeys: Array<{ id: string; secret: string | null }> };
    const legacy = list.apiKeys.find((k) => k.name === 'legacy');
    expect(legacy!.secret).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/integration/api-keys.test.ts`
Expected: FAIL — `GET /api/admin/api-keys` rows don't have `secret`; custom secret ignored

- [ ] **Step 3: Add `secret` to the zod schema**

In `src/server/routes/admin/api-keys.ts`, add to `ApiKeyCreate`:

```typescript
const ApiKeyCreate = z.object({
  name: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
  secret: z.string().min(1).max(256).optional(), // custom key value, used verbatim
  expiresAt: z.string().nullable().optional(),
  allowAllModels: z.boolean().optional(),
  permissions: z.array(PermEntry).optional(),
  ipRules: z.array(IPRule).optional(),
  // ...rest unchanged...
});
```

- [ ] **Step 4: Add imports at the top of `api-keys.ts`**

```typescript
import { encryptSecret, decryptSecret } from '../../auth/crypto';
```

- [ ] **Step 5: Implement POST handler changes**

Replace the body of `app.post('/api/admin/api-keys', ...)` so the secret source, digest,
and encrypted-at-rest columns are all handled:

```typescript
app.post('/api/admin/api-keys', async (req) => {
  const body = ApiKeyCreate.parse(req.body);
  const db = getDb();
  // Custom secret (verbatim) or auto-generated `ld-<base64url32>`
  const secret = body.secret && body.secret.trim().length > 0
    ? body.secret.trim()
    : generateApiKeySecret();
  const id = uuid();
  const keyPrefix = secret.slice(0, 11);
  const keyDigest = sha256Hex(secret);
  const enc = encryptSecret(secret);
  db.insert(schema.apiKeys).values({
    id,
    name: body.name,
    keyPrefix,
    keyDigest,
    keySecretEncrypted: enc.ciphertext,
    keySecretNonce: enc.nonce,
    keySecretVersion: enc.version,
    enabled: body.enabled ?? true,
    expiresAt: body.expiresAt ?? null,
    allowAllModels: body.allowAllModels ?? false,
    rpmLimit: body.rpmLimit ?? null,
    tpmLimit: body.tpmLimit ?? null,
    dailyTokenLimit: body.dailyTokenLimit ?? null,
    monthlyTokenLimit: body.monthlyTokenLimit ?? null,
    maxConcurrent: body.maxConcurrent ?? null,
    maxOutputTokensPerRequest: body.maxOutputTokensPerRequest ?? null,
    cacheOverrideEnabled: body.cacheOverrideEnabled ?? null,
  }).run();
  if (body.permissions) {
    for (const p of body.permissions) {
      db.insert(schema.apiKeyModelPermissions).values({ id: uuid(), apiKeyId: id, targetKind: p.targetKind, targetId: p.targetId }).run();
    }
  }
  if (body.ipRules) {
    for (const r of body.ipRules) {
      db.insert(schema.apiKeyIpRules).values({ id: uuid(), apiKeyId: id, mode: r.mode, cidr: r.cidr }).run();
    }
  }
  recordAudit({ action: 'api_key.create', success: true, targetType: 'api_key', targetId: id, targetName: body.name, ip: req.ip, metadata: { permissions: body.permissions?.length ?? 0, custom: body.secret ? true : false } });
  // Return full secret ONCE (also recoverable later via list/detail)
  return { id, name: body.name, secret, keyPrefix };
});
```

- [ ] **Step 6: Implement GET handler changes**

List handler (`GET /api/admin/api-keys`), add a `secret` field per row:

```typescript
apiKeys: rows.map((k) => ({
  id: k.id,
  name: k.name,
  keyPrefix: k.keyPrefix,
  enabled: k.enabled,
  expiresAt: k.expiresAt,
  lastUsedAt: k.lastUsedAt,
  allowAllModels: k.allowAllModels,
  modelScopeCount: perms.filter((p) => p.apiKeyId === k.id).length,
  rpmLimit: k.rpmLimit,
  tpmLimit: k.tpmLimit,
  concurrencyLimit: k.maxConcurrent,
  secret: k.keySecretEncrypted && k.keySecretNonce
    ? decryptSecret({ ciphertext: k.keySecretEncrypted, nonce: k.keySecretNonce, version: k.keySecretVersion ?? 1 })
    : null,
})),
```

Detail handler (`GET /api/admin/api-keys/:id`), add `secret` to the returned object:

```typescript
secret: k.keySecretEncrypted && k.keySecretNonce
  ? decryptSecret({ ciphertext: k.keySecretEncrypted, nonce: k.keySecretNonce, version: k.keySecretVersion ?? 1 })
  : null,
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm exec vitest run tests/integration/api-keys.test.ts`
Expected: PASS (all 3 cases)

- [ ] **Step 8: Run full test suite**

Run: `pnpm test`
Expected: PASS

---

### Task 5: API key UI — custom key input + Copy/Eye per row

**Files:**
- Modify: `src/web/app/pages/api-keys.tsx`
- Test: `tests/e2e/critical.spec.ts`

**Interfaces:**
- Consumes: `GET /api/admin/api-keys` now returns `secret: string | null` per row; `POST /api/admin/api-keys` accepts optional `secret`
- Produces: new key modal has optional "Key value" input; table action cell has Copy + Eye buttons; e2e test 6 index positions preserved

**Placement constraint:** the existing e2e test 6 (`inputs.nth(0)` = name, `inputs.nth(2)` = RPM) depends on input order. The **"Key value (optional)" input must go LAST in the dialog** (after the Concurrency limit, before the Allow-all switch) so those index positions stay stable.

- [ ] **Step 1: Update imports**

Change the lucide import to include `Eye`:

```typescript
import { Plus, Copy, Eye } from 'lucide-react';
```

- [ ] **Step 2: Modify the create dialog**

Add `customSecret` to the form state:

```typescript
const [form, setForm] = useState({ name: '', expiresAt: '', allowAll: true, permissions: [] as Perm[], rpmLimit: '', tpmLimit: '', concurrency: '', customSecret: '' });
```

In the dialog JSX, **after the 3-limit grid** (`RPM limit` / `TPM limit` / `Concurrency`), and **before** the Allow-all switch row, insert:

```tsx
<div>
  <Label>Key value (optional)</Label>
  <Input
    value={form.customSecret}
    onChange={(e) => setForm({ ...form, customSecret: e.target.value })}
    placeholder="Leave empty to auto-generate ld-…"
  />
  <p className="text-xs text-muted-foreground">If provided, this exact value is stored as the key. Otherwise a random ld-… key is generated.</p>
</div>
```

In the `submit` function, send `secret` (spread only when non-empty):

```typescript
const r = await api.post<{ secret: string; name: string }>('/api/admin/api-keys', {
  name: form.name,
  expiresAt: form.expiresAt || null,
  allowAllModels: form.allowAll,
  permissions: form.allowAll ? undefined : form.permissions,
  rpmLimit: form.rpmLimit ? Number(form.rpmLimit) : null,
  tpmLimit: form.tpmLimit ? Number(form.tpmLimit) : null,
  maxConcurrent: form.concurrency ? Number(form.concurrency) : null,
  ...(form.customSecret.trim() ? { secret: form.customSecret.trim() } : {}),
});
```

Also reset `customSecret` in the form-reset line after submit:

```typescript
setForm({ name: '', expiresAt: '', allowAll: true, permissions: [], rpmLimit: '', tpmLimit: '', concurrency: '', customSecret: '' });
```

- [ ] **Step 3: Extend `KeyRow` + reveal state + table actions**

Update the `KeyRow` interface:

```typescript
interface KeyRow { id: string; name: string; keyPrefix: string; enabled: boolean; expiresAt: string | null; lastUsedAt: string | null; allowAllModels: boolean; modelScopeCount: number; rpmLimit: number | null; tpmLimit: number | null; concurrencyLimit: number | null; secret: string | null; }
```

Add a `revealRow` state near the existing `reveal`:

```typescript
const [revealRow, setRevealRow] = useState<{ secret: string; name: string } | null>(null);
```

The table body's last cell currently holds the Revoke button. Replace it so the
Copy/Eye actions sit beside Revoke for rows that have a stored secret:

```tsx
<TableCell className="text-right">
  <div className="flex items-center justify-end gap-1">
    {k.secret && (
      <>
        <Button size="sm" variant="ghost" title="Copy secret" onClick={() => { void navigator.clipboard.writeText(k.secret!); toast.success('Copied'); }}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" title="Show secret" onClick={() => setRevealRow({ secret: k.secret!, name: k.name })}>
          <Eye className="h-3.5 w-3.5" />
        </Button>
      </>
    )}
    <Button size="sm" variant="outline" onClick={() => revoke(k.id)}>Revoke</Button>
  </div>
</TableCell>
```

- [ ] **Step 4: Add the reveal dialog for per-row eye action**

Place next to the existing post-creation reveal dialog (near the end of the component):

```tsx
<Dialog open={!!revealRow} onOpenChange={(o) => { if (!o) setRevealRow(null); }}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>API key: {revealRow?.name}</DialogTitle>
      <DialogDescription>Full secret for this key, readable any time.</DialogDescription>
    </DialogHeader>
    <div className="rounded border bg-muted p-3 font-mono text-xs break-all">{revealRow?.secret}</div>
    <DialogFooter>
      <Button onClick={() => { if (revealRow) { void navigator.clipboard.writeText(revealRow.secret); toast.success('Copied'); } }}><Copy className="mr-1 h-4 w-4" /> Copy</Button>
      <Button variant="outline" onClick={() => setRevealRow(null)}>Close</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 5: Build the web bundle**

Run: `pnpm run build:web`
Expected: No TS/ESLint errors.

- [ ] **Step 6: Add/update E2E coverage in `critical.spec.ts`**

Test 6 (existing) keeps its input indices because "Key value" is last — it should stay green unchanged. Add a new serial test **after** test 6 that exercises the recoverable-secret flow. Append inside the same `describe` block:

```typescript
test('6b. API key secret is recoverable after modal closes + custom key verbatim', async ({ page }) => {
  // Custom key submitted verbatim.
  await page.goto('/api-keys');
  await page.getByRole('button', { name: 'New key' }).click();
  const dialog = page.locator('[role="dialog"]');
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill('E2E custom key');
  // Last input (after name/expires/rpm/tpm/concurrency, since Key value is last).
  await inputs.nth(5).fill('my-very-own-api-key-123456');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForSelector('text=API key created', { timeout: 5000 });
  const created = await dialog.locator('.font-mono.text-xs').textContent();
  await dialog.getByRole('button', { name: 'I have saved it' }).click();
  await expect(page.getByText('E2E custom key')).toBeVisible({ timeout: 5000 });

  // Eye action shows the full custom secret even after the modal closed.
  const row = page.getByRole('row').filter({ hasText: 'E2E custom key' });
  await row.getByTitle('Show secret').click();
  const reveal = page.locator('[role="dialog"]').last();
  await expect(reveal.locator('.font-mono.text-xs')).toHaveText('my-very-own-api-key-123456', { timeout: 5000 });
  await reveal.getByRole('button', { name: 'Close' }).click();

  // Auto-generated key also readable.
  await page.getByRole('button', { name: 'New key' }).click();
  const d2 = page.locator('[role="dialog"]').last();
  await d2.locator('input').nth(0).fill('E2E auto key');
  await d2.getByRole('button', { name: 'Create' }).click();
  await page.waitForSelector('text=API key created', { timeout: 5000 });
  const autoSecret = await d2.locator('.font-mono.text-xs').textContent();
  await d2.getByRole('button', { name: 'I have saved it' }).click();
  const row2 = page.getByRole('row').filter({ hasText: 'E2E auto key' });
  await row2.getByTitle('Show secret').click();
  const reveal2 = page.locator('[role="dialog"]').last();
  await expect(reveal2.locator('.font-mono.text-xs')).toHaveText(autoSecret!.trim(), { timeout: 5000 });
  void created;
});
```

- [ ] **Step 7: Run E2E tests**

Run: `pnpm test:e2e`
Expected: PASS — including new test 6b and unchanged test 6

---

### Task 6: Logo — extract PNG, produce favicon + logo, wire into HTML + pages

**Files:**
- Create: `scripts/generate-logo.ts`, `src/web/public/favicon.png`, `src/web/public/logo.png`
- Modify: `src/web/index.html`, `src/web/components/sidebar.tsx`, `src/web/app/pages/login.tsx`, `src/web/app/pages/setup.tsx`, `package.json`
- Delete: `src/web/public/favicon.svg`

**Interfaces:**
- Consumes: `latedev.svg` at project root
- Produces: `favicon.png` (48×48), `logo.png` (128×128); HTML `<link>` and UI `<img>` tags

- [ ] **Step 1: Install `pngjs` devDependency**

```bash
pnpm add -D pngjs
pnpm add -D @types/pngjs
```

- [ ] **Step 2: Write the logo generation script**

Uses `fileURLToPath` (not `import.meta.dirname`) for broad Node compatibility, and
average 2×2 box sampling for cleaner downscaling than single-pixel read:

```typescript
// scripts/generate-logo.ts
// One-off: extract the embedded PNG from latedev.svg and emit small favicon + logo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_PATH = path.join(ROOT, 'latedev.svg');
const PUBLIC_DIR = path.join(ROOT, 'src/web/public');

function extractPngFromSvg(svgPath: string): Buffer {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const match = svg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error('No embedded PNG found in latedev.svg');
  return Buffer.from(match[1]!, 'base64');
}

function boxDownsample(src: PNG.PNG, targetSize: number): PNG.PNG {
  const dst = new PNG({ width: targetSize, height: targetSize });
  const scale = src.width / targetSize; // source pixels per output pixel
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * scale), x1 = Math.min(Math.ceil((x + 1) * scale), src.width);
      const y0 = Math.floor(y * scale), y1 = Math.min(Math.ceil((y + 1) * scale), src.height);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
          n++;
        }
      }
      const o = (y * targetSize + x) * 4;
      dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = a / n;
    }
  }
  return dst;
}

const pngData = extractPngFromSvg(SVG_PATH);
const src = PNG.sync.read(pngData);
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.png'), PNG.sync.write(boxDownsample(src, 48)));
fs.writeFileSync(path.join(PUBLIC_DIR, 'logo.png'), PNG.sync.write(boxDownsample(src, 128)));
console.log('Generated favicon.png (48x48) and logo.png (128x128)');
```

- [ ] **Step 3: Run the script**

```bash
node --import tsx/esm scripts/generate-logo.ts
```

Expected: `Generated favicon.png (48x48) and logo.png (128x128)`. Verify both files exist and are small (likely < 30 KB each; confirm by `ls -la src/web/public/*.png`).

- [ ] **Step 4: Wire into HTML + pages**

**`src/web/index.html`**: change `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` to:

```html
<link rel="icon" type="image/png" href="/favicon.png" />
```

**`src/web/components/sidebar.tsx`**: replace the "L" block:

```tsx
<img src="/logo.png" alt="LateDev Router" className="h-7 w-7 object-contain" />
```

**`src/web/app/pages/login.tsx`**: replace the "L" block:

```tsx
<img src="/logo.png" alt="LateDev Router" className="h-8 w-8 object-contain" />
```

**`src/web/app/pages/setup.tsx`**: replace the "L" block:

```tsx
<img src="/logo.png" alt="LateDev Router" className="h-8 w-8 object-contain rounded bg-primary" />
```

- [ ] **Step 5: Remove old favicon SVG**

```bash
rm src/web/public/favicon.svg
```

- [ ] **Step 6: Build and verify**

```bash
pnpm run build
```

Check `dist/web/index.html` has the favicon reference. Check `dist/web/favicon.png` and `dist/web/logo.png` exist.

- [ ] **Step 7: Add logo assertions inside the existing e2e test 1**

Test 1 already leaves the user logged in on the Dashboard, so a standalone `goto('/')` would be redirected to login. Instead append to the body of test `'1. first run -> create admin -> login'`, right after the existing `Dashboard` visibility assertion:

```typescript
// Brand logo appears in the sidebar (not the placeholder letter).
const sidebarLogo = page.locator('aside img[src*="logo.png"]');
await expect(sidebarLogo).toBeVisible({ timeout: 5000 });
```

Run the whole e2e suite to confirm test 1 still passes with the added assertion.

---

### Task 7: Docs update + final integration

**Files:**
- Modify: `docs/05-API-KEYS-LIMITS-AND-IP.md`, `docs/07-SECURITY-ADMIN-AND-BACKUP.md`, `docs/08-ADMIN-UI-UX.md`, `.env.example`

- [ ] **Step 1: Update `docs/05`**

Add a line after "show plaintext once after creation":

```
- store encrypted (AES-256-GCM) for admin recovery via the admin API
```

- [ ] **Step 2: Update `docs/07`**

Add a paragraph in the "Master key behavior" section:

```
Auto-generated master key: when LATEDEV_MASTER_KEY is not set and the data
directory is fresh, the setup process generates a 32-byte random key and
stores it in <dataDir>/master.key (mode 0600). This file is not included
in database backups. When restoring a backup on another host, the original
master.key file must also be deployed, or LATEDEV_MASTER_KEY must be set
in the environment.
```

- [ ] **Step 3: Update `docs/08`**

In the API key create flow, update step 7:

```
7. show `ld-...` secret once in a high-attention dialog with Copy button
   (optional: enter a custom key value in step 1)
8. after creation, every key row has a Copy and a Show action that retrieves
   the full secret from the database (encrypted at rest)
```

- [ ] **Step 4: Update `.env.example`**

Change the `LATEDEV_MASTER_KEY` comment:

```
# Master encryption key for provider credentials.
# If unset on a fresh data directory, the setup process auto-generates one
# and stores it in <dataDir>/master.key (mode 0600).
# Generate manually with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- [ ] **Step 5: Run full build + test suite**

```bash
pnpm run build
pnpm test
pnpm test:e2e
```

Expected: All pass.

- [ ] **Step 6: Run npm pack dry-run to verify tarball contents**

```bash
npm pack --dry-run
```

Expected: `dist/`, `README.md`, `LICENSE`, `migrations/` included. No `master.key` or `latedev.svg` root file.