# Review package: Task 2 — Setup: auto-gen master key + file write + cache fix

**Scope:** `src/server/routes/admin/setup.ts` (modified) + `tests/integration/master-key.test.ts` (created).
**Not a git repo** — this package shows final file states.

## `src/server/routes/admin/setup.ts` (final, post-change)

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import argon2 from 'argon2';
import { getDb, schema } from '../../db/index';
import { getSettings, markSetupComplete, updateSettings } from '../../db/repositories/settings';
import { recordAudit } from '../../db/repositories/audit';
import { loadConfig, setConfigMasterKey } from '../../config/index';
import { GatewayError } from '../../errors';
import { uuid } from '../../auth/ids';
import { isMasterKeyConfigured } from '../../auth/crypto';

const SetupBody = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(256),
  setupMasterKey: z.string().min(32).max(64).optional(),
});

const PasswordPolicy = z.string().min(12, 'Password must be at least 12 characters').max(256);

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/setup/status', async () => {
    const s = getSettings();
    return {
      setupComplete: s.setupComplete,
      masterKeyConfigured: s.masterKeyConfigured || isMasterKeyConfigured(),
    };
  });

  app.post('/api/admin/setup', async (req, _reply) => {
    const s = getSettings();
    if (s.setupComplete) {
      throw new GatewayError('invalid_request_error', 'Setup already complete', { status: 400 });
    }
    const body = SetupBody.parse(req.body);
    PasswordPolicy.parse(body.password);
    const db = getDb();

    const id = uuid();
    const passwordHash = await argon2.hash(body.password, {
      type: argon2.argon2id,
      memoryCost: 64 * 1024,
      timeCost: 3,
      parallelism: 1,
    });

    const existing = db.select().from(schema.adminAccount).get();
    if (existing) {
      throw new GatewayError('invalid_request_error', 'Admin account already exists', { status: 400 });
    }

    db.insert(schema.adminAccount).values({ id, username: body.username, passwordHash }).run();

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
    markSetupComplete();
    recordAudit({ action: 'admin.setup', success: true, targetType: 'admin', targetId: id, targetName: body.username, ip: req.ip });
    return { ok: true };
  });
}
```

## `tests/integration/master-key.test.ts` (created, verbatim from plan)

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-mk-test-${Date.now()}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
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
    expect(content.length).toBe(44);
  });

  it('provider creation succeeds in same process (regression for config cache bug)', async () => {
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }),
    });
    expect(loginRes.status).toBe(200);
    const cookies = loginRes.headers.get('set-cookie') ?? '';
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

## Test evidence (from implementer report)

- Pre-implementation: `master.key` not created; provider create returned 503 (predicted failures)
- Post-implementation: 2/2 PASS
- Full suite: 13 files / 54 tests PASS; typecheck + lint clean

## Global constraints binding this task (from plan, verbatim)

- Master key never stored in SQLite, never returned by UI/API, never logged
- `master.key` file in data dir, mode 0600 — not in backup, not in npm tarball
- Setup flow: env set → env wins (no file write); `setupMasterKey` provided → use it and write file; file exists → reuse; else generate `crypto.randomBytes(32).toString('base64')` and write
- Test-order caveat (singleFork): this test deletes LATEDEV_MASTER_KEY at module scope — plan documents this is intentional