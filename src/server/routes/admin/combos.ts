// Admin API: combos CRUD + member management.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { uuid } from '../../auth/ids';
import { GatewayError } from '../../errors';

const MemberSpec = z.object({ modelId: z.string(), position: z.number().int().min(0), weight: z.number().int().min(1).default(1), enabled: z.boolean().default(true) });

const ComboCreate = z.object({
  name: z.string().min(1).max(128),
  slug: z.string().min(1).max(64).optional(),
  mode: z.enum(['fallback', 'weighted_round_robin']),
  maxTotalAttempts: z.number().int().min(1).max(8).optional(),
  enabled: z.boolean().optional(),
  fallbackOnConnection: z.boolean().optional(),
  fallbackOnConnectTimeout: z.boolean().optional(),
  fallbackOnFirstTokenTimeout: z.boolean().optional(),
  fallbackOn408: z.boolean().optional(),
  fallbackOn429: z.boolean().optional(),
  fallbackOn5xx: z.boolean().optional(),
  members: z.array(MemberSpec).min(1).max(16),
});

const ComboUpdate = ComboCreate.partial().extend({ id: z.string() });

// Combo public IDs default to the (normalized) name WITHOUT a prefix — e.g.
// name "gpt-5.5" becomes model id "gpt-5.5". Only when the client explicitly
// supplies a slug does the id get the "combo/" prefix ("combo/<slug>").
// Unlike slugify(), dots are preserved: they are legal in model IDs
// (e.g. "gpt-5.6-sol").
function comboSlug(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[\s/]+/g, '-')
      .replace(/[^a-z0-9._-]+/g, '')
      .slice(0, 64) || 'item'
  );
}

export async function registerComboRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/combos', async () => {
    const db = getDb();
    const combos = db.select().from(schema.combos).all();
    const allMembers = db.select().from(schema.comboMembers).all();
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    return {
      combos: combos.map((c) => {
        const members = allMembers.filter((m) => m.comboId === c.id);
        const healthy = members.filter((m) => {
          const model = modelMap.get(m.modelId);
          return model && model.enabled && model.upstreamAvailable;
        });
        return {
          id: c.id,
          name: c.name,
          slug: c.slug,
          publicModelId: c.publicModelId,
          mode: c.mode,
          enabled: c.enabled,
          memberCount: members.length,
          healthyMemberCount: healthy.length,
        };
      }),
    };
  });

  app.get('/api/admin/combos/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const c = db.select().from(schema.combos).where(eq(schema.combos.id, id)).get();
    if (!c) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    const members = db.select().from(schema.comboMembers).where(eq(schema.comboMembers.comboId, id)).all();
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    return {
      combo: {
        ...c,
        members: members.map((m) => ({
          id: m.id,
          modelId: m.modelId,
          publicModelId: modelMap.get(m.modelId)?.publicModelId ?? '',
          displayName: modelMap.get(m.modelId)?.displayName ?? '',
          providerSlug: '',
          position: m.position,
          weight: m.weight,
          enabled: m.enabled,
        })),
      },
    };
  });

  app.post('/api/admin/combos', async (req) => {
    const body = ComboCreate.parse(req.body);
    const db = getDb();
    // No slug given → the public id IS the normalized name (no "combo/" prefix).
    const slug = comboSlug(body.slug ?? body.name);
    const publicModelId = body.slug ? `combo/${slug}` : slug;
    // The id must be globally unique across combos AND physical models — the
    // resolver treats every name as one routing surface.
    if (db.select().from(schema.combos).where(eq(schema.combos.publicModelId, publicModelId)).get()) {
      throw new GatewayError('invalid_request_error', 'Combo ID already in use', { status: 400 });
    }
    if (db.select().from(schema.models).where(eq(schema.models.publicModelId, publicModelId)).get()) {
      throw new GatewayError('invalid_request_error', `A model with ID "${publicModelId}" already exists`, { status: 400 });
    }

    // Verify all referenced models exist and are physical
    const modelIds = body.members.map((m) => m.modelId);
    const models = db.select().from(schema.models).where(sql`id IN (${sql.join(modelIds.map((id) => sql`${id}`), sql`, `)})`).all();
    if (models.length !== new Set(modelIds).size) throw new GatewayError('invalid_request_error', 'One or more members are not valid physical models', { status: 400 });

    const id = uuid();
    db.insert(schema.combos).values({
      id,
      name: body.name,
      slug,
      publicModelId,
      mode: body.mode,
      enabled: body.enabled ?? true,
      maxTotalAttempts: body.maxTotalAttempts ?? 3,
      fallbackOnConnection: body.fallbackOnConnection ?? true,
      fallbackOnConnectTimeout: body.fallbackOnConnectTimeout ?? true,
      fallbackOnFirstTokenTimeout: body.fallbackOnFirstTokenTimeout ?? true,
      fallbackOn408: body.fallbackOn408 ?? true,
      fallbackOn429: body.fallbackOn429 ?? true,
      fallbackOn5xx: body.fallbackOn5xx ?? true,
      configVersion: 1,
    }).run();
    for (const m of body.members) {
      db.insert(schema.comboMembers).values({ id: uuid(), comboId: id, modelId: m.modelId, position: m.position, weight: m.weight ?? 1, enabled: m.enabled ?? true }).run();
    }
    recordAudit({ action: 'combo.create', success: true, targetType: 'combo', targetId: id, targetName: body.name, ip: req.ip, metadata: { members: body.members.length, mode: body.mode } });
    return { id, slug, publicModelId };
  });

  app.patch('/api/admin/combos', async (req) => {
    const body = ComboUpdate.parse(req.body);
    const db = getDb();
    const c = db.select().from(schema.combos).where(eq(schema.combos.id, body.id)).get();
    if (!c) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    const update: Partial<typeof schema.combos.$inferInsert> = { updatedAt: new Date().toISOString(), configVersion: c.configVersion + 1 };
    if (body.name) update.name = body.name;
    if (body.slug !== undefined) {
      // Same rule as creation: empty slug → plain id, provided slug → combo/<slug>.
      const slug = comboSlug(body.slug || body.name || c.name);
      const publicModelId = body.slug ? `combo/${slug}` : slug;
      const clashCombo = db.select().from(schema.combos).where(eq(schema.combos.publicModelId, publicModelId)).get();
      if (clashCombo && clashCombo.id !== body.id) throw new GatewayError('invalid_request_error', 'Combo ID already in use', { status: 400 });
      if (db.select().from(schema.models).where(eq(schema.models.publicModelId, publicModelId)).get()) {
        throw new GatewayError('invalid_request_error', `A model with ID "${publicModelId}" already exists`, { status: 400 });
      }
      update.slug = slug;
      update.publicModelId = publicModelId;
    }
    if (body.mode) update.mode = body.mode;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.maxTotalAttempts !== undefined) update.maxTotalAttempts = body.maxTotalAttempts;
    if (body.fallbackOnConnection !== undefined) update.fallbackOnConnection = body.fallbackOnConnection;
    if (body.fallbackOnConnectTimeout !== undefined) update.fallbackOnConnectTimeout = body.fallbackOnConnectTimeout;
    if (body.fallbackOnFirstTokenTimeout !== undefined) update.fallbackOnFirstTokenTimeout = body.fallbackOnFirstTokenTimeout;
    if (body.fallbackOn408 !== undefined) update.fallbackOn408 = body.fallbackOn408;
    if (body.fallbackOn429 !== undefined) update.fallbackOn429 = body.fallbackOn429;
    if (body.fallbackOn5xx !== undefined) update.fallbackOn5xx = body.fallbackOn5xx;
    db.update(schema.combos).set(update).where(eq(schema.combos.id, body.id)).run();
    if (body.members) {
      db.delete(schema.comboMembers).where(eq(schema.comboMembers.comboId, body.id)).run();
      for (const m of body.members) {
        db.insert(schema.comboMembers).values({ id: uuid(), comboId: body.id, modelId: m.modelId, position: m.position, weight: m.weight ?? 1, enabled: m.enabled ?? true }).run();
      }
    }
    // Invalidate cache for this combo
    const { invalidateCacheFor } = await import('../../caching/store');
    invalidateCacheFor('combo', body.id);
    recordAudit({ action: 'combo.update', success: true, targetType: 'combo', targetId: body.id, targetName: c.name, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/admin/combos/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const c = db.select().from(schema.combos).where(eq(schema.combos.id, id)).get();
    if (!c) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    db.delete(schema.combos).where(eq(schema.combos.id, id)).run();
    const { invalidateCacheFor } = await import('../../caching/store');
    invalidateCacheFor('combo', id);
    recordAudit({ action: 'combo.delete', success: true, targetType: 'combo', targetId: id, targetName: c.name, ip: req.ip });
    return { ok: true };
  });
}
