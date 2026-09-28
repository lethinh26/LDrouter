// Admin API: dashboard summary.

import type { FastifyInstance } from 'fastify';
import { and, desc, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { circuitBlocks } from '../../routing/circuit';

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/dashboard', async () => {
    const db = getDb();
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startIso = startOfDay.toISOString();

    const today = db
      .select({
        total: sql<number>`COUNT(*)`,
        success: sql<number>`SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)`,
        totalTokens: sql<number>`COALESCE(SUM(total_tokens),0)`,
      })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, startIso))
      .get();

    const providerHealth = db.select().from(schema.providers).all();
    const recentFailures = db
      .select()
      .from(schema.requests)
      .where(and(sql`success = 0`, gte(schema.requests.createdAt, startIso)))
      .orderBy(desc(schema.requests.createdAt))
      .limit(5)
      .all();

    const recentAttempts = db.select().from(schema.requestAttempts).where(gte(schema.requestAttempts.startedAt, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())).orderBy(desc(schema.requestAttempts.startedAt)).limit(500).all();
    const models = db.select().from(schema.models).all();
    const providers = db.select().from(schema.providers).all();
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const modelHealth = models.map((m) => {
      const provider = providerMap.get(m.providerId);
      const attempts = recentAttempts.filter((a) => a.modelId === m.id);
      const lastFailure = attempts.find((a) => !a.success);
      const circuitOpen = circuitBlocks(m.providerId, provider?.cbCooldownSeconds ?? 0);
      const state = !provider?.enabled ? 'disabled' : provider.healthState === 'down' ? 'provider_down' : provider.healthState === 'circuit_open' || circuitOpen ? 'circuit_open' : !m.enabled ? 'disabled' : !m.upstreamAvailable ? 'unavailable' : 'ready';
      return { id: m.id, publicModelId: m.publicModelId, upstreamModelId: m.upstreamModelId, providerId: m.providerId, providerName: provider?.name ?? null, state, attempts: attempts.length, failures: attempts.filter((a) => !a.success).length, lastFailureAt: lastFailure?.startedAt ?? null, lastFailureReason: lastFailure?.failureReason ?? null };
    });
    const modelHealthMap = new Map(modelHealth.map((m) => [m.id, m]));
    const combos = db.select().from(schema.combos).all();
    const comboMembers = db.select().from(schema.comboMembers).all();
    const comboHealth = combos.map((combo) => {
      const members = comboMembers.filter((member) => member.comboId === combo.id);
      const readyMembers = members.filter((member) => member.enabled && modelHealthMap.get(member.modelId)?.state === 'ready');
      const reasons = [...new Set(members.filter((member) => !member.enabled || modelHealthMap.get(member.modelId)?.state !== 'ready').map((member) => modelHealthMap.get(member.modelId)?.state ?? 'model_missing'))];
      return { id: combo.id, publicModelId: combo.publicModelId, enabled: combo.enabled, state: !combo.enabled ? 'disabled' : readyMembers.length > 0 ? 'ready' : 'unavailable', readyMembers: readyMembers.length, memberCount: members.length, reasons };
    });

    return {
      today: {
        total: Number(today?.total ?? 0),
        success: Number(today?.success ?? 0),
        failed: Number(today?.failed ?? 0),
        totalTokens: Number(today?.totalTokens ?? 0),
      },
      providers: providerHealth.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        type: p.type,
        health: p.healthState,
        enabled: p.enabled,
      })),
      recentFailures: recentFailures.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        requestedModel: r.requestedModel,
        errorType: r.errorType,
        errorMessage: r.errorMessage,
        httpStatus: r.httpStatus,
      })),
      models: modelHealth,
      combos: comboHealth,
    };
  });
}
