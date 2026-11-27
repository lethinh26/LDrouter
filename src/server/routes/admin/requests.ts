// Admin API: request logs + attempts (server-side paginated).

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, gte, like, lte, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { isAdminIpAllowed } from '../../security/admin-ip-gate';
import { redactJsonString } from '../../security/redact';
import { onRequestLogged, offRequestLogged, onRequestStarted, offRequestStarted } from '../../gateway/events';
import type { RequestLogSummary, AttemptLog } from '../../../shared/types';
import { providerPublicPrefix } from '../../providers/builtin';

type RequestRow = typeof schema.requests.$inferSelect;
const REQUEST_STREAM_REPLAY_PAGE_SIZE = 100;
const REQUEST_STREAM_MAX_REPLAY_ROWS = 10_000;
const REQUEST_STREAM_LIVE_REPLAY_DEDUPE_LIMIT = 1000;
// Keep the production queue at 10k; a smaller test threshold exercises the
// same overflow/replay path without inserting tens of thousands of rows.
const REQUEST_STREAM_PENDING_LIVE_LIMIT = process.env.NODE_ENV === 'test' ? 100 : 10_000;
const REQUEST_STREAM_AUTH_RECHECK_MS = 5_000;

let requestStreamReplayTestGate: (() => Promise<void>) | null = null;

/** @internal Deterministic replay coordination for the SSE overflow regression test. */
export function setRequestStreamReplayTestGateForTests(gate: (() => Promise<void>) | null): void {
  if (process.env.NODE_ENV === 'test') requestStreamReplayTestGate = gate;
}

interface RequestStreamCursor {
  createdAt: string;
  id: string;
}

function parseRequestStreamCursor(query: Record<string, unknown>): RequestStreamCursor {
  const fallback = new Date(Date.now() - 5_000).toISOString();
  const rawSince = query.since;
  let createdAt = fallback;
  let validSince = false;

  if (typeof rawSince === 'string' && /^\d{1,16}$/.test(rawSince)) {
    const timestamp = Number(rawSince);
    const date = new Date(timestamp);
    if (Number.isSafeInteger(timestamp) && timestamp >= 0 && Number.isFinite(date.getTime())) {
      createdAt = date.toISOString();
      validSince = true;
    }
  } else if (
    typeof rawSince === 'string'
    && rawSince.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(rawSince)
    && Number.isFinite(Date.parse(rawSince))
  ) {
    // Preserve the exact database timestamp text; Date.parse would truncate
    // sub-millisecond precision if a future schema ever introduces it.
    createdAt = rawSince;
    validSince = true;
  }

  const rawId = query.afterId;
  const id = validSince && typeof rawId === 'string' && rawId.length > 0 && rawId.length <= 512
    ? rawId
    : '';
  return { createdAt, id };
}

function afterRequestCursor(cursor: RequestStreamCursor) {
  return or(
    gt(schema.requests.createdAt, cursor.createdAt),
    and(eq(schema.requests.createdAt, cursor.createdAt), gt(schema.requests.id, cursor.id)),
  );
}

interface SummaryMaps {
  keyMap: Map<string, { name: string }>;
  modelMap: Map<string, { providerId: string | null; publicModelId: string; upstreamModelId: string }>;
  providerMap: Map<string, { name: string; slug: string; type: string }>;
}

export function loadSummaryMaps(): SummaryMaps {
  const db = getDb();
  const keys = db.select().from(schema.apiKeys).all();
  const models = db.select().from(schema.models).all();
  const providers = db.select().from(schema.providers).all();
  return {
    keyMap: new Map(keys.map((k) => [k.id, k])),
    modelMap: new Map(models.map((m) => [m.id, m])),
    providerMap: new Map(providers.map((p) => [p.id, { name: p.name, slug: providerPublicPrefix(db, p), type: p.type }])),
  };
}

// Shared row → API summary mapping (used by the list endpoint, the SSE stream, and stats).
export function toSummary(r: RequestRow, maps: SummaryMaps, attempts?: ReadonlyArray<Pick<typeof schema.requestAttempts.$inferSelect, 'modelId' | 'providerId' | 'attemptNumber'>>): RequestLogSummary {
  const { keyMap, modelMap, providerMap } = maps;
  const key = r.apiKeyId ? keyMap.get(r.apiKeyId) : null;
  const finalModel = r.finalModelId ? modelMap.get(r.finalModelId) : null;
  // Historical attempts retain IDs even after the model and provider rows are removed.
  // Use the matching final model's latest attempt; never guess from an unrelated fallback.
  let providerId = finalModel?.providerId ?? null;
  if (!providerId && r.finalModelId) {
    providerId = (attempts
      ? attempts.filter((a) => a.modelId === r.finalModelId).reduce<typeof attempts[number] | undefined>(
          (latest, a) => !latest || a.attemptNumber > latest.attemptNumber ? a : latest, undefined)
      : getDb().select({ providerId: schema.requestAttempts.providerId })
          .from(schema.requestAttempts)
          .where(and(eq(schema.requestAttempts.requestId, r.id), eq(schema.requestAttempts.modelId, r.finalModelId)))
          .orderBy(desc(schema.requestAttempts.attemptNumber))
          .limit(1).get())?.providerId ?? null;
  }
  const provider = providerId ? providerMap.get(providerId) : null;
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
    resolvedTargetId: r.resolvedTargetId,
    finalModelPublicId: finalModel?.publicModelId ?? (r.finalModelId ? `Deleted model (${r.finalModelId})` : null),
    finalModelUpstreamId: finalModel?.upstreamModelId ?? null,
    finalModelDeleted: Boolean(r.finalModelId && !finalModel),
    providerId,
    providerName: provider?.name ?? (providerId ? `Deleted provider (${providerId})` : null),
    providerSlug: provider?.slug ?? null,
    providerDeleted: Boolean(providerId && !provider),
    providerType: provider?.type ?? null,
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

function quoteCurlJson(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildReproductionCurl(request: RequestRow, redactedPayload: string | null): string {
  const endpoint = request.protocol === 'anthropic'
    ? '/v1/messages'
    : `/v1/${request.endpoint.replace(/^\/?v1\/?/, '')}`;
  let body: Record<string, unknown> = { model: request.requestedModel };
  if (redactedPayload) {
    try {
      const parsed = JSON.parse(redactedPayload) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = { ...(parsed as Record<string, unknown>), model: request.requestedModel };
    } catch { }
  }
  const headers = request.protocol === 'anthropic'
    ? "-H 'x-api-key: REPLACE_WITH_LD_KEY' -H 'anthropic-version: 2023-06-01'"
    : "-H 'Authorization: Bearer ld-REPLACE_WITH_KEY'";
  return `curl http://localhost:8787${endpoint} -H 'content-type: application/json' ${headers} --data-raw ${quoteCurlJson(JSON.stringify(body))}`;
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
    const sessionId = req.adminSessionId;
    reply.hijack();
    const cursor = parseRequestStreamCursor(req.query as Record<string, unknown>);
    const response = reply.raw;

    // Standard SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.flushHeaders(); // ensure the client sees the stream immediately, even with an empty replay

    let closed = false;
    const closeStream = (destroy = false): void => {
      if (closed) return;
      closed = true;
      try {
        if (destroy) response.destroy();
        else if (!response.destroyed && !response.writableEnded) response.end();
      } catch {
        response.destroy();
      }
    };
    const send = (data: string): boolean => {
      if (closed) return false;
      try {
        return response.write(data);
      } catch {
        closeStream(true);
        return false;
      }
    };

    const db = getDb();
    const maps = loadSummaryMaps();
    let replaying = true;
    const pendingLiveRequestIds = new Set<string>();
    const pendingStartedEvents = new Map<string, { requestId: string; providerId: string; modelId: string; requestedModel: string; ttftMs: number }>();
    let flushingLive = false;

    const waitForDrain = async (): Promise<void> => {
      if (closed || !response.writableNeedDrain) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          response.off('drain', finish);
          response.off('close', finish);
          response.off('finish', finish);
          response.off('error', finish);
          resolve();
        };
        response.once('drain', finish);
        response.once('close', finish);
        response.once('finish', finish);
        response.once('error', finish);
      });
    };

    const startedFrame = (data: { requestId: string; providerId: string; modelId: string; requestedModel: string; ttftMs: number }): string => {
      const provider = maps.providerMap.get(data.providerId);
      return `event: request_started\ndata: ${JSON.stringify({ ...data, providerName: provider?.name ?? null, createdAt: new Date().toISOString() })}\n\n`;
    };

    const flushPendingLive = async (): Promise<void> => {
      if (flushingLive || replaying || closed) return;
      flushingLive = true;
      try {
        while (!closed && (pendingStartedEvents.size > 0 || pendingLiveRequestIds.size > 0)) {
          await waitForDrain();
          if (closed) break;

          const started = [...pendingStartedEvents.values()];
          pendingStartedEvents.clear();
          for (let index = 0; index < started.length; index += 1) {
            if (closed) break;
            if (!send(startedFrame(started[index]!)) && response.writableNeedDrain) {
              for (const pending of started.slice(index + 1)) pendingStartedEvents.set(pending.requestId, pending);
              break;
            }
          }
          if (closed) break;
          if (response.writableNeedDrain) continue;

          const requestIds = [...pendingLiveRequestIds];
          pendingLiveRequestIds.clear();
          for (let index = 0; index < requestIds.length; index += 1) {
            if (closed) break;
            const requestId = requestIds[index]!;
            const row = db.select().from(schema.requests).where(eq(schema.requests.id, requestId)).get();
            if (!row) continue;
            if (!send(`event: request\ndata: ${JSON.stringify(toSummary(row, maps))}\n\n`) && response.writableNeedDrain) {
              for (const pendingId of requestIds.slice(index + 1)) pendingLiveRequestIds.add(pendingId);
              break;
            }
          }
        }
      } finally {
        flushingLive = false;
        if (!replaying && !closed && (pendingStartedEvents.size > 0 || pendingLiveRequestIds.size > 0)) {
          void flushPendingLive();
        }
      }
    };

    // History replay is emitted after the live listeners are registered.

    // Live: subscribe to the event bus.
    const handleRequestLogged = (requestId: string): void => {
      if (closed) return;
      if (replaying || flushingLive || response.writableNeedDrain) {
        pendingLiveRequestIds.add(requestId);
        if (pendingLiveRequestIds.size > REQUEST_STREAM_PENDING_LIVE_LIMIT) {
          // Final completions are durable. Close without advancing the client
          // cursor; reconnect replay recovers every row not yet delivered.
          closeStream();
          return;
        }
        if (!replaying) void flushPendingLive();
        return;
      }
      const row = db.select().from(schema.requests).where(eq(schema.requests.id, requestId)).get();
      if (row) send(`event: request\ndata: ${JSON.stringify(toSummary(row, maps))}\n\n`);
    };
    onRequestLogged(handleRequestLogged);

    // A request is being served (first token reached): intentionally best-effort
    // and live-only — it is not persisted or replayed. The monitoring dashboard
    // uses it to light the route until the durable completion event arrives.
    const handleRequestStarted = (data: { requestId: string; providerId: string | null; modelId: string; requestedModel: string; ttftMs: number }): void => {
      if (closed || !data.providerId) return;
      const started = { ...data, providerId: data.providerId };
      if (replaying || flushingLive || response.writableNeedDrain) {
        pendingStartedEvents.set(data.requestId, started);
        if (pendingStartedEvents.size > REQUEST_STREAM_LIVE_REPLAY_DEDUPE_LIMIT) {
          // Drop the oldest transient route pulse rather than growing memory;
          // the final persisted completion remains durable and replayable.
          const oldestId = pendingStartedEvents.keys().next().value;
          if (oldestId) pendingStartedEvents.delete(oldestId);
        }
        if (!replaying) void flushPendingLive();
        return;
      }
      send(startedFrame(started));
    };
    onRequestStarted(handleRequestStarted);

    // Keepalive ping every 25s.
    const keepAlive = setInterval(() => {
      if (!response.writableNeedDrain) send(': ping\n\n');
    }, 25_000);
    // Auto-close after 5 min; the client reconnects with its last seen timestamp.
    const autoClose = setTimeout(() => {
      closeStream();
    }, 5 * 60_000);
    const authRecheck = setInterval(() => {
      if (closed) return;
      try {
        const session = sessionId
          ? db.select({ expiresAt: schema.adminSessions.expiresAt }).from(schema.adminSessions).where(eq(schema.adminSessions.id, sessionId)).get()
          : undefined;
        const sessionValid = Boolean(session && new Date(session.expiresAt).getTime() >= Date.now());
        if (sessionValid && isAdminIpAllowed(req)) return;
      } catch {
        // Fail closed if session or current access policy cannot be verified.
      }
      closeStream();
    }, REQUEST_STREAM_AUTH_RECHECK_MS);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      closed = true;
      clearInterval(keepAlive);
      clearInterval(authRecheck);
      clearTimeout(autoClose);
      offRequestLogged(handleRequestLogged);
      offRequestStarted(handleRequestStarted);
      response.off('close', cleanup);
      response.off('finish', cleanup);
      response.off('error', cleanup);
      pendingLiveRequestIds.clear();
      pendingStartedEvents.clear();
    };
    // Listen on the *response*: req.raw (IncomingMessage) emits 'close' as soon as the
    // request message is consumed (immediately for a GET), which would tear down the
    // stream before any live event. reply.raw (ServerResponse) 'close' fires when the
    // response completes or the connection terminates — the canonical SSE signal.
    reply.raw.on('close', cleanup);
    reply.raw.on('finish', cleanup);
    reply.raw.on('error', cleanup);

    // Replay persisted completions in bounded keyset pages. The ID component
    // continues through historical timestamp ties; newly persisted completion
    // timestamps are strictly increasing, so live events cannot arrive behind
    // an already-delivered completion cursor.
    let firstPage = cursor.id.length === 0;
    let lastCreatedAt = cursor.createdAt;
    let lastId = cursor.id;
    let replayedRows = 0;
    while (!closed && replayedRows < REQUEST_STREAM_MAX_REPLAY_ROWS) {
      const cursorCondition = firstPage
        ? gte(schema.requests.createdAt, cursor.createdAt)
        : afterRequestCursor({ createdAt: lastCreatedAt, id: lastId });
      const page = db
        .select()
        .from(schema.requests)
        .where(cursorCondition)
        .orderBy(asc(schema.requests.createdAt), asc(schema.requests.id))
        .limit(Math.min(REQUEST_STREAM_REPLAY_PAGE_SIZE, REQUEST_STREAM_MAX_REPLAY_ROWS - replayedRows))
        .all();
      if (page.length === 0) break;

      firstPage = false;
      for (const row of page) {
        lastCreatedAt = row.createdAt;
        lastId = row.id;
        if (closed) break;
        replayedRows += 1;
        pendingLiveRequestIds.delete(row.id);
        pendingStartedEvents.delete(row.id);
        send('event: request\ndata: ' + JSON.stringify(toSummary(row, maps)) + '\n\n');
      }

      // Hold the stream after its first replay page only when the integration
      // test explicitly installs a gate. This proves live completions overflow
      // the bounded queue while historical replay is still in progress.
      if (process.env.NODE_ENV === 'test' && replayedRows === REQUEST_STREAM_REPLAY_PAGE_SIZE) {
        const gate = requestStreamReplayTestGate;
        requestStreamReplayTestGate = null;
        await gate?.();
      }

      await waitForDrain();
      if (page.length < REQUEST_STREAM_REPLAY_PAGE_SIZE) break;
      if (!closed) await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // If the bounded replay window has more rows, close before flushing queued
    // live completions. A live row beyond the replay boundary must never move
    // the reconnect cursor past older, not-yet-replayed history.
    const hasMoreReplay = !closed && replayedRows >= REQUEST_STREAM_MAX_REPLAY_ROWS
      ? Boolean(db.select({ id: schema.requests.id })
        .from(schema.requests)
        .where(afterRequestCursor({ createdAt: lastCreatedAt, id: lastId }))
        .limit(1)
        .get())
      : false;
    if (hasMoreReplay) {
      closeStream();
      return;
    }

    replaying = false;
    await flushPendingLive();
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
    const maps = loadSummaryMaps();
    const { providerMap, modelMap } = maps;
    return {
      request: {
        ...toSummary(r, maps, attempts),
        requestPayload: redactJsonString(r.requestPayloadJson),
        responsePayload: redactJsonString(r.responsePayloadJson),
        reproductionCurl: buildReproductionCurl(r, redactJsonString(r.requestPayloadJson)),
        fallbackReasons: [...new Set(attempts.map((a) => a.failureReason).filter((reason): reason is string => Boolean(reason)))],
      },
      attempts: attempts.map<AttemptLog>((a) => ({
        id: a.id,
        attemptNumber: a.attemptNumber,
        providerId: a.providerId,
        providerName: providerMap.get(a.providerId)?.name ?? `Deleted provider (${a.providerId})`,
        modelId: a.modelId,
        modelPublicId: modelMap.get(a.modelId)?.publicModelId ?? `Deleted model (${a.modelId})`,
        upstreamModelId: modelMap.get(a.modelId)?.upstreamModelId ?? '',
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
