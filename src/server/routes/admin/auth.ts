import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { getDb, schema } from '../../db/index';
import { recordAudit } from '../../db/repositories/audit';
import { uuid, generateSessionToken, sha256Hex } from '../../auth/ids';
import { requireAdminAuth } from '../../auth/middleware';
import { GatewayError } from '../../errors';

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().optional(),
});

const SessionCookie = 'ld_session';
const COOKIE_MAX_AGE = 60 * 60 * 12; // 12h

function sessionExpiry(): string {
  return new Date(Date.now() + COOKIE_MAX_AGE * 1000).toISOString();
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const db = getDb();
    const account = db.select().from(schema.adminAccount).get();
    if (!account) throw new GatewayError('authentication_error', 'Invalid credentials', { status: 401 });

    const ok = await argon2.verify(account.passwordHash, body.password);
    db.insert(schema.loginAttempts).values({
      id: uuid(),
      username: body.username,
      ip: req.ip,
      success: ok,
    }).run();

    if (!ok) {
      recordAudit({ action: 'admin.login', success: false, ip: req.ip, targetName: body.username });
      throw new GatewayError('authentication_error', 'Invalid credentials', { status: 401 });
    }

    if (account.totpEnabled) {
      if (body.recoveryCode) {
        // Verify against any unused recovery code
        const codes = db.select().from(schema.adminRecoveryCodes).where(sql`admin_id = ${account.id} AND used_at IS NULL`).all();
        let matched = false;
        for (const c of codes) {
          if (await argon2.verify(c.codeHash, body.recoveryCode)) {
            db.update(schema.adminRecoveryCodes).set({ usedAt: new Date().toISOString() }).where(sql`id = ${c.id}`).run();
            matched = true;
            break;
          }
        }
        if (!matched) {
          recordAudit({ action: 'admin.login', success: false, ip: req.ip, targetName: body.username, metadata: { reason: 'recovery_code' } });
          throw new GatewayError('authentication_error', 'Invalid recovery code', { status: 401 });
        }
      } else if (body.totp) {
        const ok2 = await verifyTotp(account, body.totp);
        if (!ok2) {
          recordAudit({ action: 'admin.login', success: false, ip: req.ip, targetName: body.username, metadata: { reason: 'totp' } });
          throw new GatewayError('authentication_error', 'Invalid TOTP', { status: 401 });
        }
      } else {
        // TOTP required, not provided
        reply.code(401).send({ error: { type: 'totp_required', message: 'TOTP code required' } });
        return;
      }
    }

    // Issue session
    const token = generateSessionToken();
    const id = uuid();
    db.insert(schema.adminSessions).values({
      id,
      tokenDigest: sha256Hex(token),
      expiresAt: sessionExpiry(),
      ip: req.ip,
      userAgent: (req.headers['user-agent'] ?? '').toString().slice(0, 256),
    }).run();

    db.update(schema.adminAccount).set({ lastLoginAt: new Date().toISOString() }).where(sql`id = ${account.id}`).run();

    recordAudit({ action: 'admin.login', success: true, ip: req.ip, targetType: 'admin', targetId: account.id, targetName: account.username });

    reply.setCookie(SessionCookie, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: COOKIE_MAX_AGE,
    });
    return { ok: true, username: account.username, totpEnabled: account.totpEnabled };
  });

  app.post('/api/admin/logout', async (req, reply) => {
    const token = req.cookies[SessionCookie];
    if (token) {
      const digest = sha256Hex(token);
      const db = getDb();
      db.delete(schema.adminSessions).where(sql`token_digest = ${digest}`).run();
    }
    reply.clearCookie(SessionCookie, { path: '/' });
    return { ok: true };
  });

  app.get('/api/admin/me', { preHandler: requireAdminAuth }, async (req) => {
    const account = req.adminAccount!;
    return {
      id: account.id,
      username: account.username,
      totpEnabled: account.totpEnabled,
    };
  });
}

async function verifyTotp(account: typeof schema.adminAccount.$inferSelect, code: string): Promise<boolean> {
  if (!account.totpSecretEncrypted || !account.totpSecretNonce) return false;
  // Lazy-load to avoid breaking things if crypto module not yet ready
  const { decryptSecret } = await import('../../auth/crypto');
  const speakeasy = await import('speakeasy');
  const payload = { ciphertext: account.totpSecretEncrypted, nonce: account.totpSecretNonce, version: 1 };
  try {
    const secret = decryptSecret({ ciphertext: payload.ciphertext, nonce: payload.nonce, version: 1 });
    return (speakeasy as unknown as { authenticator: { verify: (o: { token: string; secret: string; window?: number }) => boolean } }).authenticator.verify({ token: code, secret, window: 1 });
  } catch {
    return false;
  }
}

import { sql } from 'drizzle-orm';
