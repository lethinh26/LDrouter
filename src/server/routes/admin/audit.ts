// Admin API: audit logs.

import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../../auth/middleware';
import { queryAudit } from '../../db/repositories/audit';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/audit', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { rows, total } = queryAudit({
      from: q.from,
      to: q.to,
      action: q.action,
      success: q.success === undefined ? undefined : q.success === 'true',
      search: q.search,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return { total, rows };
  });
}
