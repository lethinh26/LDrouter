// Admin API: app settings + password + TOTP + maintenance.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { getSettings, updateSettings } from '../../db/repositories/settings';
import { uuid } from '../../auth/ids';
import { isMasterKeyConfigured, encryptSecret, decryptSecret } from '../../auth/crypto';
import { GatewayError } from '../../errors';
import { runRetentionCleanup } from '../../maintenance/retention';
import { parseCidr, ipMatchesAny } from '../../util/cidr';
import { resolveClientIp } from '../../util/client-ip';

const UpdateBody = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional(),
  contentLogMode: z.enum(['off', 'metadata', 'prompt', 'prompt_and_response']).optional(),
  dbSizeLimitMb: z.number().int().min(64).max(1048576).optional(),
  trustProxyHops: z.number().int().min(0).max(8).optional(),
  gatewayCacheEnabled: z.boolean().optional(),
  gatewayCacheDefaultTtlSeconds: z.number().int().min(1).max(86400).optional(),
  gatewayCacheMaxSizeMb: z.number().int().min(1).max(10240).optional(),
  notificationsEnabled: z.boolean().optional(),
  notificationSoundEnabled: z.boolean().optional(),
  adminIpAllow: z.string().max(4096).optional().nullable(),
  adminIpBlock: z.string().max(4096).optional().nullable(),
});

const PasswordChange = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(256),
  totp: z.string().optional(),
  recoveryCode: z.string().optional(),
});

const TotpEnableBegin = z.object({});
void TotpEnableBegin;
const TotpEnableVerify = z.object({ code: z.string().regex(/^\d{6}$/) });

// speakeasy v2 exports at top level (no `authenticator` namespace). Under ESM
// interop the module may arrive as { default: {...} }. Normalize once here so
// every TOTP site uses the v2 API: generateSecret(), totp.verify({secret,
// encoding:'base32', token, window}), otpauthURL({secret, label, issuer}).
async function loadSpeakeasy(): Promise<{
  generateSecret: (o: { name: string; length: number }) => { base32: string; ascii: string };
  totp: { verify: (o: { secret: string; encoding: string; token: string; window?: number }) => boolean };
  otpauthURL: (o: { secret: string; label: string; issuer?: string }) => string;
}> {
  const m = await import('speakeasy');
  return (m as { default?: unknown }).default as never ?? (m as never);
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/settings', async () => {
    const s = getSettings();
    return { settings: { ...s, masterKeyConfigured: s.masterKeyConfigured || isMasterKeyConfigured() } };
  });

  app.patch('/api/admin/settings', async (req) => {
    const body = UpdateBody.parse(req.body);
    let addedIp: string | null = null;
    // Validate + normalize the admin IP access lists.
    if (body.adminIpAllow !== undefined) {
      const lines = (body.adminIpAllow ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 100);
      for (const l of lines) {
        try { parseCidr(l); } catch { throw new GatewayError('invalid_request_error', `Invalid entry in IP allow list: "${l}"`, { status: 400 }); }
      }
      // Lockout guard: when a non-empty allow list is configured, the caller's
      // own IP must be covered — otherwise saving would lock the admin out of
      // their own site (the gate is enforced on the next request).
      const callerIp = resolveClientIp(req);
      if (lines.length > 0 && !ipMatchesAny(callerIp, lines)) {
        lines.push(callerIp);
        addedIp = callerIp;
      }
      body.adminIpAllow = lines.length ? lines.join('\n') : null;
    }
    if (body.adminIpBlock !== undefined) {
      const lines = (body.adminIpBlock ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 100);
      for (const l of lines) {
        try { parseCidr(l); } catch { throw new GatewayError('invalid_request_error', `Invalid entry in IP block list: "${l}"`, { status: 400 }); }
      }
      body.adminIpBlock = lines.length ? lines.join('\n') : null;
    }
    updateSettings(body);
    recordAudit({ action: 'settings.update', success: true, ip: req.ip, metadata: { fields: Object.keys(body), addedIp } });
    return { ok: true, addedIp };
  });

  app.post('/api/admin/settings/cleanup', async (req) => {
    const result = runRetentionCleanup();
    recordAudit({ action: 'retention.run', success: true, ip: req.ip, metadata: { result } });
    return { ok: true, result };
  });

  app.post('/api/admin/settings/cache/clear', async (req) => {
    const { clearAllCache } = await import('../../caching/store');
    const n = clearAllCache();
    recordAudit({ action: 'cache.clear', success: true, ip: req.ip, metadata: { deleted: n } });
    return { ok: true, deleted: n };
  });

  // Password change
  app.post('/api/admin/account/password', async (req) => {
    const body = PasswordChange.parse(req.body);
    const account = req.adminAccount!;
    const db = getDb();
    const ok = await argon2.verify(account.passwordHash, body.currentPassword);
    if (!ok) {
      recordAudit({ action: 'admin.password_change', success: false, ip: req.ip, metadata: { reason: 'wrong_current' } });
      throw new GatewayError('authentication_error', 'Current password incorrect', { status: 401 });
    }
    if (account.totpEnabled && !body.totp && !body.recoveryCode) {
      throw new GatewayError('invalid_request_error', 'TOTP or recovery code required', { status: 400 });
    }
    if (account.totpEnabled && body.totp) {
      const secret = decryptSecret({ ciphertext: account.totpSecretEncrypted!, nonce: account.totpSecretNonce!, version: 1 });
      const sp = await loadSpeakeasy();
      if (!sp.totp.verify({ token: body.totp, secret, encoding: 'base32', window: 1 })) {
        recordAudit({ action: 'admin.password_change', success: false, ip: req.ip, metadata: { reason: 'bad_totp' } });
        throw new GatewayError('authentication_error', 'Invalid TOTP', { status: 401 });
      }
    }
    const newHash = await argon2.hash(body.newPassword, { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 });
    db.update(schema.adminAccount).set({ passwordHash: newHash, updatedAt: new Date().toISOString() }).where(eq(schema.adminAccount.id, account.id)).run();
    // Invalidate all other sessions
    db.delete(schema.adminSessions).where(sql`id != ${req.adminSessionId}`).run();
    recordAudit({ action: 'admin.password_change', success: true, ip: req.ip });
    return { ok: true };
  });

  // TOTP setup
  app.post('/api/admin/account/totp/begin', async (req) => {
    if (!isMasterKeyConfigured()) throw new GatewayError('gateway_error', 'Master key required to enable TOTP', { status: 503 });
    const sp = await loadSpeakeasy();
    const qrcode = (await import('qrcode')) as unknown as { toDataURL: (t: string) => Promise<string> };
    const secret = sp.generateSecret({ name: 'LateDev Router', length: 20 });
    const enc = encryptSecret(secret.base32);
    const db = getDb();
    db.update(schema.adminAccount).set({ totpSecretEncrypted: enc.ciphertext, totpSecretNonce: enc.nonce, updatedAt: new Date().toISOString() }).where(eq(schema.adminAccount.id, req.adminAccount!.id)).run();
    const otpauth = sp.otpauthURL({ secret: secret.ascii, label: 'admin', issuer: 'LateDev Router' });
    const qr = await qrcode.toDataURL(otpauth);
    recordAudit({ action: 'totp.begin', success: true, ip: req.ip });
    return { secret: secret.base32, otpauth, qr };
  });

  app.post('/api/admin/account/totp/verify', async (req) => {
    const body = TotpEnableVerify.parse(req.body);
    const account = req.adminAccount!;
    if (!account.totpSecretEncrypted) throw new GatewayError('invalid_request_error', 'Begin TOTP setup first', { status: 400 });
    const sp = await loadSpeakeasy();
    const secret = decryptSecret({ ciphertext: account.totpSecretEncrypted, nonce: account.totpSecretNonce!, version: 1 });
    if (!sp.totp.verify({ token: body.code, secret, encoding: 'base32', window: 1 })) {
      recordAudit({ action: 'totp.verify', success: false, ip: req.ip });
      throw new GatewayError('invalid_request_error', 'Invalid code', { status: 400 });
    }
    // Generate recovery codes
    const { generateRecoveryCodes } = await import('../../auth/recovery');
    const db = getDb();
    db.delete(schema.adminRecoveryCodes).where(eq(schema.adminRecoveryCodes.adminId, account.id)).run();
    const codes = generateRecoveryCodes(8);
    for (const c of codes) {
      const codeHash = await argon2.hash(c, { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 });
      db.insert(schema.adminRecoveryCodes).values({ id: uuid(), adminId: account.id, codeHash }).run();
    }
    db.update(schema.adminAccount).set({ totpEnabled: true, updatedAt: new Date().toISOString() }).where(eq(schema.adminAccount.id, account.id)).run();
    recordAudit({ action: 'totp.enable', success: true, ip: req.ip, metadata: { recoveryCodes: codes.length } });
    return { ok: true, recoveryCodes: codes };
  });

  app.post('/api/admin/account/totp/disable', async (req) => {
    const body = z.object({ password: z.string().min(1), totp: z.string().optional(), recoveryCode: z.string().optional() }).parse(req.body);
    const account = req.adminAccount!;
    const ok = await argon2.verify(account.passwordHash, body.password);
    if (!ok) {
      recordAudit({ action: 'totp.disable', success: false, ip: req.ip, metadata: { reason: 'wrong_password' } });
      throw new GatewayError('authentication_error', 'Invalid password', { status: 401 });
    }
    if (account.totpEnabled && !body.totp && !body.recoveryCode) {
      throw new GatewayError('invalid_request_error', 'TOTP or recovery code required', { status: 400 });
    }
    if (account.totpEnabled && body.totp) {
      const secret = decryptSecret({ ciphertext: account.totpSecretEncrypted!, nonce: account.totpSecretNonce!, version: 1 });
      const sp = await loadSpeakeasy();
      if (!sp.totp.verify({ token: body.totp, secret, encoding: 'base32', window: 1 })) {
        recordAudit({ action: 'totp.disable', success: false, ip: req.ip, metadata: { reason: 'bad_totp' } });
        throw new GatewayError('authentication_error', 'Invalid TOTP', { status: 401 });
      }
    }
    const db = getDb();
    db.update(schema.adminAccount).set({ totpEnabled: false, totpSecretEncrypted: null, totpSecretNonce: null, updatedAt: new Date().toISOString() }).where(eq(schema.adminAccount.id, account.id)).run();
    db.delete(schema.adminRecoveryCodes).where(eq(schema.adminRecoveryCodes.adminId, account.id)).run();
    recordAudit({ action: 'totp.disable', success: true, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/account/totp/recovery/regenerate', async (req) => {
    const body = z.object({ password: z.string().min(1), totp: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const account = req.adminAccount!;
    if (!account.totpEnabled) throw new GatewayError('invalid_request_error', 'TOTP not enabled', { status: 400 });
    const ok = await argon2.verify(account.passwordHash, body.password);
    if (!ok) throw new GatewayError('authentication_error', 'Invalid password', { status: 401 });
    const sp = await loadSpeakeasy();
    const secret = decryptSecret({ ciphertext: account.totpSecretEncrypted!, nonce: account.totpSecretNonce!, version: 1 });
    if (!sp.totp.verify({ token: body.totp, secret, encoding: 'base32', window: 1 })) throw new GatewayError('authentication_error', 'Invalid TOTP', { status: 401 });
    const { generateRecoveryCodes } = await import('../../auth/recovery');
    const db = getDb();
    db.delete(schema.adminRecoveryCodes).where(eq(schema.adminRecoveryCodes.adminId, account.id)).run();
    const codes = generateRecoveryCodes(8);
    for (const c of codes) {
      const codeHash = await argon2.hash(c, { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 });
      db.insert(schema.adminRecoveryCodes).values({ id: uuid(), adminId: account.id, codeHash }).run();
    }
    recordAudit({ action: 'totp.recovery_regenerate', success: true, ip: req.ip });
    return { ok: true, recoveryCodes: codes };
  });

  // Health-test endpoint
  app.get('/api/admin/settings/system', async () => {
    const { loadConfig } = await import('../../config/index');
    const cfg = loadConfig();
    return {
      appVersion: cfg.appVersion,
      dataDir: cfg.dataDir,
      masterKeyConfigured: isMasterKeyConfigured(),
      masterKeyVersion: getSettings().masterKeyVersion,
      environment: cfg.env,
    };
  });

  // Self-update: check the npm registry and (optionally) install + restart.
  app.get('/api/admin/update/check', async (req) => {
    const { getSelfUpdater } = await import('../../selfupdate/index');
    const u = getSelfUpdater();
    const force = (req.query as Record<string, string | undefined>).force === '1';
    const result = await u.check(force);
    return { ...result, status: u.status() };
  });

  app.post('/api/admin/update/run', async () => {
    const { getSelfUpdater } = await import('../../selfupdate/index');
    return getSelfUpdater().run();
  });
}
