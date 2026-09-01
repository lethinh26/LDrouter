// Admin API: request logs + attempts (server-side paginated).

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, like, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { redactJsonString } from '../../security/redact';
import { onRequestLogged, offRequestLogged, onRequestStarted, offRequestStarted } from '../../gateway/events';
import type { RequestLogSummary, AttemptLog } from '../../../shared/types';

type RequestRow = typeof schema.requests.$inferSelect;

interface SummaryMaps {
  keyMap: Map<string, { name: string }>;
  modelMap: Map<string, { providerId: string | null; publicModelId: string }>;
  providerMap: Map<string, { name: string }>;
}

export function loadSummaryMaps(): SummaryMaps {
  const db = getDb();
  const keys = db.select().from(schema.apiKeys).all();
  const models = db.select().from(schema.models).all();
  const providers = db.select().from(schema.providers).all();
  return {
    keyMap: new Map(keys.map((k) => [k.id, k])),
    modelMap: new Map(models.map((m) => [m.id, m])),
    providerMap: new Map(providers.map((p) => [p.id, p])),
  };
}

// Shared row → API summary mapping (used by the list endpoint, the SSE stream, and stats).
export function toSummary(r: RequestRow, maps: SummaryMaps): RequestLogSummary {
  const { keyMap, modelMap, providerMap } = maps;
  const key = r.apiKeyId ? keyMap.get(r.apiKeyId) : null;
  const finalModel = r.finalModelId ? modelMap.get(r.finalModelId) : null;
  const provider = finalModel?.providerId ? providerMap.get(finalModel.providerId) : null;
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
    providerId: provider ? finalModel!.providerId : null,
    providerName: provider?.name ?? null,
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
  } satisfies RequestLogSummary as RequestLogSummary;
}

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
    const maps = loadSummaryMaps();

    return {
      total: totalRow?.c ?? 0,
      requests: rows.map((r) => toSummary(r, maps)),
    };
  });

  // SSE stream of request completions (client reconnects with `since` of its last seen event).
  app.get('/api/admin/requests/stream', async (req, reply) => {
    reply.hijack();
    const q = req.query as Record<string, string | undefined>;
    const parsedSince = Number(q.since);
    const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : Date.now() - 5_000;
    const response = reply.raw;

    // Standard SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.flushHeaders(); // ensure the client sees the stream immediately, even with an empty replay

    let closed = false;
    const send = (data: string): void => {
      if (closed) return;
      try {
        response.write(data);
      } catch {
        closed = true;
      }
    };

    const db = getDb();
    const maps = loadSummaryMaps();

    // History replay: up to 20 most recent rows after `since` (oldest first so the client renders in order).
    const historyRows = db
      .select()
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, new Date(since).toISOString()))
      .orderBy(desc(schema.requests.createdAt))
      .limit(20)
      .all()
      .reverse();
    const replayIds = new Set<string>();
    for (const r of historyRows) {
      replayIds.add(r.id);
      send(`event: request\ndata: ${JSON.stringify(toSummary(r, maps))}\n\n`);
    }

    // Live: subscribe to the event bus.
    const handleRequestLogged = (requestId: string): void => {
      if (closed || replayIds.has(requestId)) return;
      const row = db.select().from(schema.requests).where(eq(schema.requests.id, requestId)).get();
      if (!row) return;
      send(`event: request\ndata: ${JSON.stringify(toSummary(row, maps))}\n\n`);
    };
    onRequestLogged(handleRequestLogged);

    // A request is being served (first token reached): live-only — not part of
    // history replay. The monitoring dashboard uses this to light the route
    // from TTFT until the completion (`request`) event arrives.
    const handleRequestStarted = (data: { requestId: string; providerId: string | null; modelId: string; requestedModel: string; ttftMs: number }): void => {
      if (closed || !data.providerId) return;
      const provider = maps.providerMap.get(data.providerId);
      send(`event: request_started\ndata: ${JSON.stringify({ requestId: data.requestId, providerId: data.providerId, providerName: provider?.name ?? null, modelId: data.modelId, requestedModel: data.requestedModel, ttftMs: data.ttftMs, createdAt: new Date().toISOString() })}\n\n`);
    };
    onRequestStarted(handleRequestStarted);

    // Keepalive ping every 25s.
    const keepAlive = setInterval(() => send(': ping\n\n'), 25_000);
    // Auto-close after 5 min; the client reconnects with its last seen timestamp.
    const autoClose = setTimeout(() => {
      response.end();
      response.destroy();
    }, 5 * 60_000);

    const cleanup = (): void => {
      closed = true;
      clearInterval(keepAlive);
      clearTimeout(autoClose);
      offRequestLogged(handleRequestLogged);
      offRequestStarted(handleRequestStarted);
    };
    // Listen on the *response*: req.raw (IncomingMessage) emits 'close' as soon as the
    // request message is consumed (immediately for a GET), which would tear down the
    // stream before any live event. reply.raw (ServerResponse) 'close' fires when the
    // response completes or the connection terminates — the canonical SSE signal.
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
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
