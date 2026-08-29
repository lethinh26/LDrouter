// Operational routes: /health, /ready, /metrics.

import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../db/index';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../config/index';
import { metricsRegistry } from '../metrics/registry';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok', version: loadConfig().appVersion };
  });

  app.get('/ready', async (_req, reply) => {
    try {
      const db = getDb();
      const row = db.select({ c: sql<number>`1` }).from(schema.appSettings).get();
      if (!row) {
        reply.code(503).send({ status: 'not_ready', reason: 'settings_missing' });
        return;
      }
      return { status: 'ready' };
    } catch (e) {
      reply.code(503).send({ status: 'not_ready', reason: 'db_error', detail: (e as Error).message });
    }
  });

  app.get('/metrics', async (_req, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(metricsRegistry.render());
  });
}
