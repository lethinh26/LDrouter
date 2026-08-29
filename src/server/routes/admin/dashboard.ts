// Admin API: dashboard summary.

import type { FastifyInstance } from 'fastify';
import { and, desc, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';

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
    };
  });
}
