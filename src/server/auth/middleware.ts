// Auth middleware: admin session validation.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getDb, schema } from '../db/index';
import { sql } from 'drizzle-orm';
import { sha256Hex } from './ids';
import { GatewayError } from '../errors';
import { recordAudit } from '../db/repositories/audit';

declare module 'fastify' {
  interface FastifyRequest {
    adminAccount?: typeof schema.adminAccount.$inferSelect;
    adminSessionId?: string;
  }
}

const SessionCookie = 'ld_session';

export async function requireAdminAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = req.cookies[SessionCookie];
  if (!token) throw new GatewayError('authentication_error', 'Login required', { status: 401 });

  const digest = sha256Hex(token);
  const db = getDb();
  const session = db
    .select()
    .from(schema.adminSessions)
    .where(sql`token_digest = ${digest}`)
    .get();
  if (!session) throw new GatewayError('authentication_error', 'Invalid session', { status: 401 });
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    db.delete(schema.adminSessions).where(sql`id = ${session.id}`).run();
    throw new GatewayError('authentication_error', 'Session expired', { status: 401 });
  }

  // Lookup admin by session's owning relationship is implicit (single admin). Get the singleton.
  const admin = db.select().from(schema.adminAccount).get();
  if (!admin) {
    db.delete(schema.adminSessions).where(sql`id = ${session.id}`).run();
    recordAudit({ action: 'admin.session.invalid', success: false, ip: req.ip });
    throw new GatewayError('authentication_error', 'Admin account missing', { status: 401 });
  }
  // Touch last_seen_at occasionally (cheap update)
  db.update(schema.adminSessions).set({ lastSeenAt: new Date().toISOString() }).where(sql`id = ${session.id}`).run();
  req.adminAccount = admin;
  req.adminSessionId = session.id;
}
