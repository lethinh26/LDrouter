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
  setupMasterKey: z.string().min(32).max(64).optional(), // optional one-shot master key
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
