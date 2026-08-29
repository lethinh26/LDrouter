import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import argon2 from 'argon2';
import { getDb, schema } from '../../db/index';
import { getSettings, markSetupComplete, updateSettings } from '../../db/repositories/settings';
import { recordAudit } from '../../db/repositories/audit';
import { loadConfig, setConfigMasterKey } from '../../config/index';
import { GatewayError } from '../../errors';
import { uuid } from '../../auth/ids';
import { isMasterKeyConfigured, parseMasterKey } from '../../auth/crypto';

const SetupBody = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(256),
  setupMasterKey: z.string().trim().min(32, 'Master key must be at least 32 characters').max(256).optional(),
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
    PasswordPolicy.parse(body.password); // throws if too short

    // Resolve the master encryption key BEFORE writing any rows: provider
    // credentials are encrypted with it, and a rejected setup must never leave
    // a half-created admin account behind. Priority: LATEDEV_MASTER_KEY env →
    // existing master.key file (re-setup) → key entered during setup. There is
    // NO auto-generation: losing this key makes stored provider API keys
    // unrecoverable, so the admin must hold a copy.
    const cfg = loadConfig();
    const keyPath = path.join(cfg.dataDir, 'master.key');
    let effectiveKey = cfg.masterKey ?? (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() || null : null);
    if (!effectiveKey) {
      if (!body.setupMasterKey) {
        throw new GatewayError('invalid_request_error', 'Master encryption key is required (32+ characters). Set LATEDEV_MASTER_KEY or enter it during setup.', { status: 400 });
      }
      effectiveKey = body.setupMasterKey;
    }
    // Reject malformed keys up front: a key that cannot be parsed into 32 AES
    // bytes would make every later provider encrypt/decrypt fail.
    try {
      parseMasterKey(effectiveKey);
    } catch (e) {
      throw new GatewayError('invalid_request_error', (e as Error).message, { status: 400 });
    }

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

    // Persist the resolved key for container restarts and set it into the
    // running config (validated above, before any rows were written).
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(keyPath, effectiveKey, { mode: 0o600, encoding: 'utf8' });
    setConfigMasterKey(effectiveKey);
    process.env.LATEDEV_MASTER_KEY = effectiveKey;
    updateSettings({ masterKeyConfigured: true });
    markSetupComplete();
    recordAudit({ action: 'admin.setup', success: true, targetType: 'admin', targetId: id, targetName: body.username, ip: req.ip });
    return { ok: true };
  });
}
