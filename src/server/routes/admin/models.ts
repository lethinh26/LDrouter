// Admin API: models management (selective import, update, enable/disable).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { uuid } from '../../auth/ids';
import { GatewayError } from '../../errors';
import type { GatewayContext, GatewayRequest } from '../../gateway/runner';
import type { CanonicalRequest } from '../../routing/capabilities';

const ImportModelsBody = z.object({
  providerId: z.string(),
  modelIds: z.array(z.string().min(1)).min(1),
});

const ModelUpdate = z.object({
  id: z.string(),
  displayName: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  upstreamAvailable: z.boolean().optional(),
  // Values may be true / false / null. null clears the key back to "unknown",
  // which the router treats as "not verified" rather than "unsupported".
  capabilities: z.record(z.union([z.boolean(), z.null()])).optional(),
  cacheOverrideEnabled: z.boolean().nullable().optional(),
  maxContextTokens: z.number().int().min(1).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).nullable().optional(),
});

/** Apply an admin capability override. `null` removes the key (= unknown). */
function applyCapabilityOverrides(stored: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...stored };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export async function registerModelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/models', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const db = getDb();
    let rows = db.select().from(schema.models).all();
    const providers = db.select().from(schema.providers).all();
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    if (q.providerId) rows = rows.filter((r) => r.providerId === q.providerId);
    if (q.enabled !== undefined) rows = rows.filter((r) => r.enabled === (q.enabled === 'true'));
    if (q.upstreamAvailable !== undefined) rows = rows.filter((r) => r.upstreamAvailable === (q.upstreamAvailable === 'true'));
    if (q.capability) rows = rows.filter((r) => {
      try {
        const caps = JSON.parse(r.capabilitiesJson) as Record<string, unknown>;
        return caps[q.capability!] === true;
      } catch { return false; }
    });
    const models = rows.map((m) => ({
      id: m.id,
      providerId: m.providerId,
      providerSlug: providerMap.get(m.providerId)?.slug ?? '',
      providerType: providerMap.get(m.providerId)?.type ?? 'openai',
      publicModelId: m.publicModelId,
      upstreamModelId: m.upstreamModelId,
      displayName: m.displayName,
      enabled: m.enabled,
      upstreamAvailable: m.upstreamAvailable,
      capabilities: safeJson(m.capabilitiesJson),
      discoveredCapabilities: m.discoveredMetadataJson ? safeJson(m.discoveredMetadataJson) : null,
      maxContextTokens: m.maxContextTokens,
      maxOutputTokens: m.maxOutputTokens,
      lastSeenUpstreamAt: m.lastSeenUpstreamAt,
      createdAt: m.createdAt,
    }));
    return { models };
  });

  app.post('/api/admin/models/import', async (req) => {
    const body = ImportModelsBody.parse(req.body);
    const db = getDb();
    const provider = db.select().from(schema.providers).where(eq(schema.providers.id, body.providerId)).get();
    if (!provider) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });

    // Fetch discovered model metadata fresh (so import uses current discovery data)
    // For simplicity: re-discover and match by upstream id.
    const { discoverProviderModels, mergeDiscoveredCapabilities } = await import('../../providers/index');
    const { decryptSecret, decryptCustomHeaders } = await import('../../auth/crypto');
    const { codexModels } = await import('../../providers/codex');
    const { getCodexAccountById, listCodexAccountSummaries } = await import('../../db/repositories/codex-accounts');
    const { withCodexCredentials } = await import('../../providers/codex-refresh');
    let discovered: Array<{ upstreamId: string; displayName: string; capabilities: Record<string, unknown> }>;
    try {
      if (provider.type === 'codex') {
        const summary = listCodexAccountSummaries(provider.id).find((candidate) => candidate.enabled && candidate.healthState !== 'down');
        const account = summary ? getCodexAccountById(summary.id) : null;
        if (!account) throw new GatewayError('authentication_error', 'No eligible Codex account is configured', { status: 503 });
        discovered = await withCodexCredentials(account.id, (credentials) => codexModels({
          baseUrl: provider.baseUrl, accountId: account.chatgptAccountId, accessToken: credentials.accessToken,
          accountRecordId: account.id, customHeaders: {}, totalTimeoutMs: Math.min(provider.totalTimeoutMs, 30000),
        }));
      } else {
        if (!provider.encryptedApiKey || !provider.apiKeyNonce) throw new GatewayError('invalid_request_error', 'Provider credentials are missing', { status: 501 });
        const apiKey = decryptSecret({ ciphertext: provider.encryptedApiKey, nonce: provider.apiKeyNonce, version: provider.apiKeyVersion });
        const headers = decryptCustomHeaders(provider.customHeadersEncrypted && provider.customHeadersNonce ? { ciphertext: provider.customHeadersEncrypted, nonce: provider.customHeadersNonce, version: 1 } : null);
        discovered = await discoverProviderModels({ type: provider.type, baseUrl: provider.baseUrl, apiKey, customHeaders: headers, connectTimeoutMs: 5000, totalTimeoutMs: 30000 });
      }
    } catch {
      discovered = [];
    }
    const discMap = new Map(discovered.map((d) => [d.upstreamId, d]));
    const now = new Date().toISOString();
    let imported = 0;
    for (const upstreamId of body.modelIds) {
      const existing = db.select().from(schema.models).where(sql`provider_id = ${provider.id} AND upstream_model_id = ${upstreamId}`).get();
      const disc = discMap.get(upstreamId);
      const caps = (disc?.capabilities as Record<string, unknown>) ?? { chat: true, streaming: true, tools: true };
      if (existing) {
        // Refresh capabilities so stale discoveries (e.g. a wrong
        // `image_input: false`) heal on re-import, while admin edits survive.
        const merged = mergeDiscoveredCapabilities(
          safeJson(existing.capabilitiesJson),
          existing.discoveredMetadataJson ? safeJson(existing.discoveredMetadataJson) : null,
          caps
        );
        db.update(schema.models)
          .set({
            upstreamAvailable: true,
            lastSeenUpstreamAt: now,
            updatedAt: now,
            capabilitiesJson: JSON.stringify(merged.capabilities),
            discoveredMetadataJson: JSON.stringify(merged.baseline),
          })
          .where(eq(schema.models.id, existing.id))
          .run();
        continue;
      }
      const publicModelId = `${provider.slug}/${upstreamId}`;
      db.insert(schema.models).values({
        id: uuid(),
        providerId: provider.id,
        upstreamModelId: upstreamId,
        publicModelId,
        displayName: disc?.displayName ?? upstreamId,
        enabled: true,
        upstreamAvailable: true,
        capabilitiesJson: JSON.stringify(caps),
        discoveredMetadataJson: JSON.stringify(caps),
        maxContextTokens: typeof caps.max_context_tokens === 'number' ? caps.max_context_tokens : null,
        maxOutputTokens: typeof caps.max_output_tokens === 'number' ? caps.max_output_tokens : null,
        lastSeenUpstreamAt: now,
      }).run();
      imported++;
    }
    recordAudit({ action: 'model.import', success: true, targetType: 'provider', targetId: provider.id, targetName: provider.name, ip: req.ip, metadata: { count: body.modelIds.length, imported } });
    return { ok: true, imported, requested: body.modelIds.length };
  });

  app.patch('/api/admin/models', async (req) => {
    const body = ModelUpdate.parse(req.body);
    const db = getDb();
    const m = db.select().from(schema.models).where(eq(schema.models.id, body.id)).get();
    if (!m) throw new GatewayError('invalid_request_error', 'Model not found', { status: 404 });
    const update: Partial<typeof schema.models.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.displayName) update.displayName = body.displayName;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.upstreamAvailable !== undefined) update.upstreamAvailable = body.upstreamAvailable;
    if (body.capabilities) {
      const merged = applyCapabilityOverrides(safeJson(m.capabilitiesJson), body.capabilities);
      update.capabilitiesJson = JSON.stringify(merged);
      if (typeof merged.max_context_tokens === 'number') update.maxContextTokens = merged.max_context_tokens;
      if (typeof merged.max_output_tokens === 'number') update.maxOutputTokens = merged.max_output_tokens;
    }
    if (body.cacheOverrideEnabled !== undefined) update.cacheOverrideEnabled = body.cacheOverrideEnabled ?? null;
    if (body.maxContextTokens !== undefined) update.maxContextTokens = body.maxContextTokens;
    if (body.maxOutputTokens !== undefined) update.maxOutputTokens = body.maxOutputTokens;
    db.update(schema.models).set(update).where(eq(schema.models.id, body.id)).run();
    recordAudit({ action: 'model.update', success: true, targetType: 'model', targetId: m.id, targetName: m.publicModelId, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/models/:id/toggle', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const m = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
    if (!m) throw new GatewayError('invalid_request_error', 'Model not found', { status: 404 });
    db.update(schema.models).set({ enabled: !m.enabled, updatedAt: new Date().toISOString() }).where(eq(schema.models.id, id)).run();
    recordAudit({ action: m.enabled ? 'model.disable' : 'model.enable', success: true, targetType: 'model', targetId: id, targetName: m.publicModelId, ip: req.ip });
    return { ok: true, enabled: !m.enabled };
  });

  app.delete('/api/admin/models/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const m = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
    if (!m) throw new GatewayError('invalid_request_error', 'Model not found', { status: 404 });
    const inCombo = db.select().from(schema.comboMembers).where(eq(schema.comboMembers.modelId, id)).all();
    if (inCombo.length > 0) {
      db.update(schema.models).set({ enabled: false, upstreamAvailable: false, updatedAt: new Date().toISOString() }).where(eq(schema.models.id, id)).run();
      recordAudit({ action: 'model.soft_disable', success: true, targetType: 'model', targetId: id, targetName: m.publicModelId, ip: req.ip, metadata: { reason: 'in_combo' } });
      return { ok: true, softDisabled: true };
    }
    db.delete(schema.models).where(eq(schema.models.id, id)).run();
    recordAudit({ action: 'model.delete', success: true, targetType: 'model', targetId: id, targetName: m.publicModelId, ip: req.ip });
    return { ok: true };
  });

  // Streaming test endpoint: streams SSE tokens to the client in real time.
  app.post('/api/admin/models/:id/test-stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const m = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
    if (!m) throw new GatewayError('invalid_request_error', 'Model not found', { status: 404 });
    if (!m.enabled) throw new GatewayError('invalid_request_error', 'Model is disabled', { status: 400 });
    if (!m.upstreamAvailable) throw new GatewayError('invalid_request_error', 'Model is not available upstream', { status: 400 });
    const provider = db.select().from(schema.providers).where(eq(schema.providers.id, m.providerId)).get();
    if (!provider || !provider.enabled) throw new GatewayError('invalid_request_error', 'Provider is disabled', { status: 400 });

    // Hijack reply so runner streams SSE directly to the client.
    reply.hijack();
    const res = reply.raw;
    const SSE_HEADERS = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    };
    let headWritten = false;
    const writeHeadOnce = () => {
      if (headWritten) return;
      headWritten = true;
      res.writeHead(200, SSE_HEADERS);
    };
    const send = (event: string, data: unknown) => {
      writeHeadOnce();
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // The runner calls reply.raw.end() as soon as the upstream completes.
    // Defer that so we can append our own test_meta event before the
    // real end(). Writes are forwarded live, so tokens still stream.
    const fakeRaw = {
      writeHead: () => writeHeadOnce(),
      write: (chunk: string | Buffer) => res.write(chunk),
      end: () => { /* deferred: real end happens in our finally */ },
    } as never;

    const { GatewayRunner } = await import('../../gateway/runner');
    const runner = new GatewayRunner();
    const canonicalReq: CanonicalRequest = {
      model: m.publicModelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Bạn là model gì?' }] }],
      stream: true,
      maxOutputTokens: 256,
      temperature: 0.7,
    };
    const requestId = `test-${uuid()}`;
    const ctx: GatewayContext = {
      requestId,
      clientIp: req.ip,
      protocol: 'openai',
      endpoint: 'chat/completions',
      requestedModel: m.publicModelId,
      key: null,
      reply: { raw: fakeRaw } as never,
    };
    const gatewayReq: GatewayRequest = {
      canonical: canonicalReq,
      protocol: 'openai',
      endpoint: 'chat/completions',
    };
    let outcome: Awaited<ReturnType<typeof runner.execute>>;
    try {
      outcome = await runner.execute(gatewayReq, ctx);
      // Runner already wrote [DONE]. Append our own test_meta event so the
      // client knows the test finished with full stats.
      send('test_meta', {
        success: outcome.success,
        latencyMs: outcome.latencyMs,
        ttftMs: outcome.ttftMs ?? null,
        usage: outcome.usage,
        attempts: outcome.attempts.map((a) => ({
          providerName: a.providerName,
          modelId: a.modelId,
          latencyMs: a.latencyMs,
          success: a.success,
          failureReason: a.failureReason,
        })),
      });
    } catch (e) {
      // Never let a raw non-GatewayError (e.g. MasterKeyError from credential
      // decryption) escape into the global handler as an opaque "Gateway error".
      if (e instanceof GatewayError) throw e;
      send('test_error', { message: (e as Error).message });
    } finally {
      res.end();
    }
  });

  // Non-streaming test endpoint (kept for backwards compatibility)
  app.post('/api/admin/models/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const m = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
    if (!m) throw new GatewayError('invalid_request_error', 'Model not found', { status: 404 });
    if (!m.enabled) throw new GatewayError('invalid_request_error', 'Model is disabled', { status: 400 });
    if (!m.upstreamAvailable) throw new GatewayError('invalid_request_error', 'Model is not available upstream', { status: 400 });
    const provider = db.select().from(schema.providers).where(eq(schema.providers.id, m.providerId)).get();
    if (!provider || !provider.enabled) throw new GatewayError('invalid_request_error', 'Provider is disabled', { status: 400 });

    const { GatewayRunner } = await import('../../gateway/runner');
    const runner = new GatewayRunner();
    const canonicalReq: CanonicalRequest = {
      model: m.publicModelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Bạn là model gì?' }] }],
      stream: false,
      maxOutputTokens: 256,
      temperature: 0.7,
    };
    const ctx: GatewayContext = {
      requestId: `test-${uuid()}`,
      clientIp: req.ip,
      protocol: 'openai',
      endpoint: 'chat/completions',
      requestedModel: m.publicModelId,
      key: null,
      reply: { raw: {} } as never, // Fake reply object; non-streaming won't use it
    };
    const gatewayReq: GatewayRequest = {
      canonical: canonicalReq,
      protocol: 'openai',
      endpoint: 'chat/completions',
    };
    let outcome: Awaited<ReturnType<typeof runner.execute>>;
    try {
      outcome = await runner.execute(gatewayReq, ctx);
    } catch (e) {
      // Never let a raw non-GatewayError (e.g. MasterKeyError from credential
      // decryption) escape into the global handler as an opaque "Gateway error".
      if (e instanceof GatewayError) throw e;
      throw new GatewayError('gateway_error', (e as Error).message, { cause: e });
    }
    recordAudit({ action: 'model.test', success: outcome.success, targetType: 'model', targetId: id, targetName: m.publicModelId, ip: req.ip });
    return {
      success: outcome.success,
      text: outcome.text ?? '',
      latencyMs: outcome.latencyMs,
      ttftMs: outcome.ttftMs ?? null,
      usage: outcome.usage,
      attempts: outcome.attempts.map((a) => ({
        providerName: a.providerName,
        modelId: a.modelId,
        latencyMs: a.latencyMs,
        ttftMs: a.ttftMs,
        success: a.success,
        failureReason: a.failureReason,
      })),
    };
  });
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
