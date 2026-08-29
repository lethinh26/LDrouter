// Admin API: model aliases CRUD.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { uuid, slugify } from '../../auth/ids';
import { GatewayError } from '../../errors';

const AliasCreate = z.object({
  alias: z.string().min(1).max(64),
  targetKind: z.enum(['model', 'combo']),
  targetId: z.string(),
  enabled: z.boolean().optional(),
});

const AliasUpdate = AliasCreate.partial().extend({ id: z.string() });

export async function registerAliasRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/aliases', async () => {
    const db = getDb();
    const rows = db.select().from(schema.modelAliases).all();
    const models = db.select().from(schema.models).all();
    const combos = db.select().from(schema.combos).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const comboMap = new Map(combos.map((c) => [c.id, c]));
    return {
      aliases: rows.map((a) => ({
        id: a.id,
        alias: a.alias,
        targetKind: a.targetKind,
        targetId: a.targetId,
        targetName: a.targetKind === 'model' ? modelMap.get(a.targetId)?.publicModelId : comboMap.get(a.targetId)?.publicModelId,
        enabled: a.enabled,
      })),
    };
  });

  app.post('/api/admin/aliases', async (req) => {
    const body = AliasCreate.parse(req.body);
    const db = getDb();
    const alias = slugify(body.alias);
    // Verify target exists and is enabled
    if (body.targetKind === 'model') {
      const m = db.select().from(schema.models).where(eq(schema.models.id, body.targetId)).get();
      if (!m) throw new GatewayError('invalid_request_error', 'Target model not found', { status: 400 });
      if (db.select().from(schema.modelAliases).where(eq(schema.modelAliases.alias, alias)).get()) {
        throw new GatewayError('invalid_request_error', 'Alias already in use', { status: 400 });
      }
      if (db.select().from(schema.models).where(eq(schema.models.publicModelId, alias)).get()) {
        throw new GatewayError('invalid_request_error', 'Alias shadows a physical model ID', { status: 400 });
      }
    } else {
      const c = db.select().from(schema.combos).where(eq(schema.combos.id, body.targetId)).get();
      if (!c) throw new GatewayError('invalid_request_error', 'Target combo not found', { status: 400 });
      if (db.select().from(schema.modelAliases).where(eq(schema.modelAliases.alias, alias)).get()) {
        throw new GatewayError('invalid_request_error', 'Alias already in use', { status: 400 });
      }
    }
    const id = uuid();
    db.insert(schema.modelAliases).values({ id, alias, targetKind: body.targetKind, targetId: body.targetId, enabled: body.enabled ?? true }).run();
    recordAudit({ action: 'alias.create', success: true, targetType: 'alias', targetId: id, targetName: alias, ip: req.ip });
    return { id, alias };
  });

  app.patch('/api/admin/aliases', async (req) => {
    const body = AliasUpdate.parse(req.body);
    const db = getDb();
    const a = db.select().from(schema.modelAliases).where(eq(schema.modelAliases.id, body.id)).get();
    if (!a) throw new GatewayError('invalid_request_error', 'Alias not found', { status: 404 });
    const update: Partial<typeof schema.modelAliases.$inferInsert> = { updatedAt: new Date().toISOString(), configVersion: a.configVersion + 1 };
    if (body.alias) update.alias = slugify(body.alias);
    if (body.targetKind) update.targetKind = body.targetKind;
    if (body.targetId) update.targetId = body.targetId;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    db.update(schema.modelAliases).set(update).where(eq(schema.modelAliases.id, body.id)).run();
    const { invalidateCacheFor } = await import('../../caching/store');
    invalidateCacheFor('alias', body.id);
    recordAudit({ action: 'alias.update', success: true, targetType: 'alias', targetId: body.id, targetName: a.alias, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/admin/aliases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const a = db.select().from(schema.modelAliases).where(eq(schema.modelAliases.id, id)).get();
    if (!a) throw new GatewayError('invalid_request_error', 'Alias not found', { status: 404 });
    db.delete(schema.modelAliases).where(eq(schema.modelAliases.id, id)).run();
    const { invalidateCacheFor } = await import('../../caching/store');
    invalidateCacheFor('alias', id);
    recordAudit({ action: 'alias.delete', success: true, targetType: 'alias', targetId: id, targetName: a.alias, ip: req.ip });
    return { ok: true };
  });
}
