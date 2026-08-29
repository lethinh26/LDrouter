// Admin API: request logs + attempts (server-side paginated).

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, like, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { redactJsonString } from '../../security/redact';
import type { RequestLogSummary, AttemptLog } from '../../../shared/types';

export async function registerRequestRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/requests', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const db = getDb();
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const offset = Math.max(Number(q.offset ?? 0), 0);

    const conds = [];
    if (q.from) conds.push(gte(schema.requests.createdAt, q.from));
    if (q.to) conds.push(lte(schema.requests.createdAt, q.to));
    if (q.success !== undefined) conds.push(eq(schema.requests.success, q.success === 'true'));
    if (q.protocol === 'openai' || q.protocol === 'anthropic') conds.push(eq(schema.requests.protocol, q.protocol));
    if (q.providerId) conds.push(eq(schema.requests.finalModelId, q.providerId)); // best-effort filter via final model
    if (q.requestedModel) conds.push(like(schema.requests.requestedModel, `%${q.requestedModel}%`));
    if (q.apiKeyId) conds.push(eq(schema.requests.apiKeyId, q.apiKeyId));
    if (q.ip) conds.push(eq(schema.requests.clientIp, q.ip));
    if (q.id) conds.push(eq(schema.requests.id, q.id));
    if (q.streaming !== undefined) conds.push(eq(schema.requests.streaming, q.streaming === 'true'));
    if (q.minStatus) conds.push(gte(schema.requests.httpStatus, Number(q.minStatus)));
    if (q.maxStatus) conds.push(lte(schema.requests.httpStatus, Number(q.maxStatus)));
    const whereExpr = conds.length ? and(...conds) : undefined;

    const rows = db.select().from(schema.requests).where(whereExpr).orderBy(desc(schema.requests.createdAt)).limit(limit).offset(offset).all();
    const totalRow = db.select({ c: sql<number>`COUNT(*)` }).from(schema.requests).where(whereExpr).get();
    const keys = db.select().from(schema.apiKeys).all();
    const keyMap = new Map(keys.map((k) => [k.id, k]));
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));

    return {
      total: totalRow?.c ?? 0,
      requests: rows.map((r) => {
        const key = r.apiKeyId ? keyMap.get(r.apiKeyId) : null;
        const finalModel = r.finalModelId ? modelMap.get(r.finalModelId) : null;
        return {
          id: r.id,
          createdAt: r.createdAt,
          completedAt: r.completedAt,
          apiKeyName: key?.name ?? null,
          keyPrefix: r.keyPrefixSnapshot,
          clientIp: r.clientIp,
          protocol: r.protocol,
          endpoint: r.endpoint,
          requestedModel: r.requestedModel,
          resolvedTargetKind: r.resolvedTargetKind,
          finalModelPublicId: finalModel?.publicModelId ?? null,
          streaming: Boolean(r.streaming),
          httpStatus: r.httpStatus,
          success: Boolean(r.success),
          totalLatencyMs: r.totalLatencyMs,
          ttftMs: r.ttftMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          reasoningTokens: r.reasoningTokens,
          totalTokens: r.totalTokens,
          attemptsCount: r.attemptsCount,
          errorType: r.errorType,
          errorMessage: r.errorMessage ?? null,
          gatewayCacheHit: Boolean(r.gatewayCacheHit),
        } satisfies RequestLogSummary;
      }),
    };
  });

  app.get('/api/admin/requests/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const r = db.select().from(schema.requests).where(eq(schema.requests.id, id)).get();
    if (!r) {
      reply.code(404).send({ error: { type: 'not_found', message: 'Request not found' } });
      return;
    }
    const attempts = db.select().from(schema.requestAttempts).where(eq(schema.requestAttempts.requestId, id)).orderBy(schema.requestAttempts.attemptNumber).all();
    const providers = db.select().from(schema.providers).all();
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const keys = db.select().from(schema.apiKeys).all();
    const keyMap = new Map(keys.map((k) => [k.id, k]));
    const key = r.apiKeyId ? keyMap.get(r.apiKeyId) : null;
    const finalModel = r.finalModelId ? modelMap.get(r.finalModelId) : null;
    return {
      request: {
        id: r.id,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        apiKeyName: key?.name ?? null,
        keyPrefix: r.keyPrefixSnapshot,
        clientIp: r.clientIp,
        protocol: r.protocol,
        endpoint: r.endpoint,
        requestedModel: r.requestedModel,
        resolvedTargetKind: r.resolvedTargetKind,
        finalModelPublicId: finalModel?.publicModelId ?? null,
        streaming: Boolean(r.streaming),
        httpStatus: r.httpStatus,
        success: Boolean(r.success),
        totalLatencyMs: r.totalLatencyMs,
        ttftMs: r.ttftMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        reasoningTokens: r.reasoningTokens,
        totalTokens: r.totalTokens,
        attemptsCount: r.attemptsCount,
        errorType: r.errorType,
        errorMessage: r.errorMessage,
        requestPayload: redactJsonString(r.requestPayloadJson),
        responsePayload: redactJsonString(r.responsePayloadJson),
        gatewayCacheHit: Boolean(r.gatewayCacheHit),
      },
      attempts: attempts.map<AttemptLog>((a) => ({
        id: a.id,
        attemptNumber: a.attemptNumber,
        providerId: a.providerId,
        providerName: providerMap.get(a.providerId)?.name ?? '',
        modelId: a.modelId,
        modelPublicId: modelMap.get(a.modelId)?.publicModelId ?? '',
        startedAt: a.startedAt,
        completedAt: a.completedAt,
        statusCode: a.statusCode,
        success: Boolean(a.success),
        latencyMs: a.latencyMs,
        ttftMs: a.ttftMs,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        cacheReadTokens: a.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens,
        reasoningTokens: a.reasoningTokens,
        streamStarted: Boolean(a.streamStarted),
        partialResponse: Boolean(a.partialResponse),
        selectionReason: a.selectionReason,
        failureReason: a.failureReason,
        sanitizedError: a.errorMessage,
        upstreamRequestId: a.upstreamRequestId,
      })),
    };
  });
}
