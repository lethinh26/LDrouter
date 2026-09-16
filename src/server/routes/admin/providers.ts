// Admin API: providers CRUD + Test Connection + Fetch Models.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { encryptSecret, decryptSecret, encryptCustomHeaders, decryptCustomHeaders, isMasterKeyConfigured } from '../../auth/crypto';
import { uuid, slugify } from '../../auth/ids';
import { GatewayError } from '../../errors';
import type { Provider } from '../../db/schema';
import { probeProvider, discoverProviderModels, type DiscoveredModel, type ProbeResult } from '../../providers/index';
import { getPooledProvider } from '../../providers/pooled';
import { redactString } from '../../security/redact';

const ProviderCreate = z.object({
  // A pool provider is nothing but a group: the admin clicks once and the server owns every field.
  // Compatible providers still need name, endpoint, and credential up front (checked in the handler).
  name: z.string().min(1).max(128).optional(),
  slug: z.string().min(1).max(64).optional(),
  type: z.enum(['openai', 'anthropic', 'codex']),
  baseUrl: z.string().url().max(512).optional(),
  apiKey: z.string().min(1).max(20000).optional(),
  customHeaders: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  connectTimeoutMs: z.number().int().min(100).max(60000).optional(),
  firstTokenTimeoutMs: z.number().int().min(100).max(300000).optional(),
  streamIdleTimeoutMs: z.number().int().min(100).max(600000).optional(),
  totalTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  maxRetries: z.number().int().min(0).max(8).optional(),
  cbFailureThreshold: z.number().int().min(1).max(50).optional(),
  cbCooldownSeconds: z.number().int().min(1).max(3600).optional(),
});

const ProviderUpdate = ProviderCreate.partial().extend({ id: z.string() });

function requireMasterKey(): void {
  if (!isMasterKeyConfigured()) {
    throw new GatewayError('gateway_error', 'Master key not configured — set LATEDEV_MASTER_KEY', { status: 503 });
  }
}

function providerToSummary(p: Provider, modelCount: number, recentErrorRate: number | null, recentAvgLatencyMs: number | null) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    type: p.type,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    health: p.healthState,
    modelCount,
    recentErrorRate,
    recentAvgLatencyMs,
  };
}

export async function registerProviderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/providers', async () => {
    const db = getDb();
    const providers = db.select().from(schema.providers).all();
    const modelCounts = db
      .select({ providerId: schema.models.providerId, c: sql<number>`COUNT(*)` })
      .from(schema.models)
      .groupBy(schema.models.providerId)
      .all();
    const counts = new Map(modelCounts.map((r) => [r.providerId, Number(r.c)]));
    return {
      providers: providers.map((p) =>
        providerToSummary(p, counts.get(p.id) ?? 0, null, null)
      ),
    };
  });

  app.post('/api/admin/providers', async (req) => {
    const body = ProviderCreate.parse(req.body);
    const pool = getPooledProvider(body.type);
    const defaults = pool?.defaults;
    const name = body.name ?? defaults?.name;
    // Pool defaults win over the request: a stored Codex base URL pointing anywhere but
    // chatgpt.com makes every upstream call 404 (see CODEX_BASE_URL).
    const baseUrl = defaults?.baseUrl ?? body.baseUrl;
    if (!name) throw new GatewayError('invalid_request_error', 'Provider name is required', { status: 400 });
    // apiKey before baseUrl: a compatible provider created without either must be told the
    // credential is missing (the UI always supplies baseUrl from its dialog default).
    if (!pool && !body.apiKey) {
      throw new GatewayError('invalid_request_error', 'API key is required for this provider type', { status: 400 });
    }
    if (!baseUrl) throw new GatewayError('invalid_request_error', 'Base URL is required', { status: 400 });
    requireMasterKey(); // Need master key to encrypt new credentials
    const db = getDb();
    const slug = slugify(body.slug ?? name);
    const dup = db.select().from(schema.providers).where(eq(schema.providers.slug, slug)).get();
    if (dup) throw new GatewayError('invalid_request_error', `Provider slug '${slug}' is already in use`, { status: 400 });
    const enc = body.apiKey ? encryptSecret(body.apiKey) : null;
    const headersEnc = body.customHeaders ? encryptCustomHeaders(body.customHeaders) : null;
    const id = uuid();
    db.insert(schema.providers).values({
      id,
      name,
      slug,
      type: body.type,
      baseUrl,
      encryptedApiKey: enc?.ciphertext ?? null,
      apiKeyNonce: enc?.nonce ?? null,
      apiKeyVersion: enc?.version ?? 1,
      customHeadersEncrypted: headersEnc?.ciphertext ?? null,
      customHeadersNonce: headersEnc?.nonce ?? null,
      enabled: body.enabled ?? true,
      connectTimeoutMs: body.connectTimeoutMs ?? 10000,
      firstTokenTimeoutMs: body.firstTokenTimeoutMs ?? 30000,
      streamIdleTimeoutMs: body.streamIdleTimeoutMs ?? 60000,
      totalTimeoutMs: body.totalTimeoutMs ?? 180000,
      maxRetries: body.maxRetries ?? 2,
      cbFailureThreshold: body.cbFailureThreshold ?? 5,
      cbCooldownSeconds: body.cbCooldownSeconds ?? 60,
    }).run();
    recordAudit({ action: 'provider.create', success: true, targetType: 'provider', targetId: id, targetName: name, ip: req.ip });
    return { id, slug };
  });

  app.patch('/api/admin/providers', async (req) => {
    const body = ProviderUpdate.parse(req.body);
    requireMasterKey(); // Need master key to encrypt/decrypt credentials
    const db = getDb();
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, body.id)).get();
    if (!p) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
    const update: Partial<typeof schema.providers.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.name) update.name = body.name;
    if (body.slug) update.slug = slugify(body.slug);
    if (body.baseUrl) update.baseUrl = getPooledProvider(p.type)?.defaults.baseUrl ?? body.baseUrl;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.connectTimeoutMs !== undefined) update.connectTimeoutMs = body.connectTimeoutMs;
    if (body.firstTokenTimeoutMs !== undefined) update.firstTokenTimeoutMs = body.firstTokenTimeoutMs;
    if (body.streamIdleTimeoutMs !== undefined) update.streamIdleTimeoutMs = body.streamIdleTimeoutMs;
    if (body.totalTimeoutMs !== undefined) update.totalTimeoutMs = body.totalTimeoutMs;
    if (body.maxRetries !== undefined) update.maxRetries = body.maxRetries;
    if (body.cbFailureThreshold !== undefined) update.cbFailureThreshold = body.cbFailureThreshold;
    if (body.cbCooldownSeconds !== undefined) update.cbCooldownSeconds = body.cbCooldownSeconds;
    if (body.apiKey) {
      const enc = encryptSecret(body.apiKey);
      update.encryptedApiKey = enc.ciphertext;
      update.apiKeyNonce = enc.nonce;
      update.apiKeyVersion = enc.version;
    }
    if (body.customHeaders) {
      const enc = encryptCustomHeaders(body.customHeaders);
      update.customHeadersEncrypted = enc?.ciphertext ?? null;
      update.customHeadersNonce = enc?.nonce ?? null;
    }
    db.update(schema.providers).set(update).where(eq(schema.providers.id, body.id)).run();
    recordAudit({ action: 'provider.update', success: true, targetType: 'provider', targetId: p.id, targetName: body.name ?? p.name, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/admin/providers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
    if (!p) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
    const used = db.select().from(schema.models).where(eq(schema.models.providerId, id)).all();
    if (used.length > 0) {
      // Soft-disable if there are dependent models
      db.update(schema.providers).set({ enabled: false, updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, id)).run();
      recordAudit({ action: 'provider.soft_disable', success: true, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip });
      return { ok: true, softDisabled: true };
    }
    // A pool provider owns its account pool. <table>.provider_id is ON DELETE RESTRICT, so the
    // accounts must go in the same transaction or the delete fails with a raw SQLite constraint
    // error (which surfaces as an opaque 500 "Gateway error").
    const pool = getPooledProvider(p.type);
    let pooledAccountsDeleted = 0;
    try {
      getRawDb().transaction(() => {
        // pool.accountsTable is a fixed registry literal, never user input.
        if (pool) pooledAccountsDeleted = getRawDb().prepare(`DELETE FROM ${pool.accountsTable} WHERE provider_id=?`).run(id).changes;
        db.delete(schema.providers).where(eq(schema.providers.id, id)).run();
      })();
    } catch (error) {
      throw new GatewayError('invalid_request_error', 'Provider is still referenced and cannot be deleted', { status: 409, cause: error });
    }
    recordAudit({ action: 'provider.delete', success: true, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip, metadata: { pooledAccountsDeleted } });
    // codexAccountsDeleted kept: pre-existing clients and tests read that field name.
    return { ok: true, pooledAccountsDeleted, codexAccountsDeleted: pooledAccountsDeleted };
  });

  app.post('/api/admin/providers/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
    if (!p) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
    const pool = getPooledProvider(p.type);
    if (pool) {
      const result = await pool.probe({ id: p.id, baseUrl: p.baseUrl, totalTimeoutMs: p.totalTimeoutMs });
      db.update(schema.providers).set({ healthState: result.ok ? 'healthy' : 'down', updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, id)).run();
      recordAudit({ action: 'provider.test', success: result.ok, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip, metadata: { detail: redactString(result.detail) } });
      return { ...result, detail: redactString(result.detail) };
    }
    if (!p.encryptedApiKey || !p.apiKeyNonce) throw new GatewayError('invalid_request_error', 'Provider credentials are missing', { status: 501 });
    const apiKey = decryptSecret({ ciphertext: p.encryptedApiKey, nonce: p.apiKeyNonce, version: p.apiKeyVersion });
    const headers = decryptCustomHeaders(p.customHeadersEncrypted && p.customHeadersNonce ? { ciphertext: p.customHeadersEncrypted, nonce: p.customHeadersNonce, version: 1 } : null);
    const result: ProbeResult = await probeProvider({
      type: p.type,
      baseUrl: p.baseUrl,
      apiKey,
      customHeaders: headers,
      connectTimeoutMs: p.connectTimeoutMs,
      totalTimeoutMs: Math.min(p.totalTimeoutMs, 20000),
    } as never);
    if (result.ok) {
      db.update(schema.providers).set({ healthState: 'healthy', updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, id)).run();
    } else {
      db.update(schema.providers).set({ healthState: 'down', updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, id)).run();
    }
    recordAudit({ action: 'provider.test', success: result.ok, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip, metadata: { detail: result.detail } });
    return result;
  });

  app.post('/api/admin/providers/:id/discover', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
    if (!p) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
    let discovered: DiscoveredModel[];
    const pool = getPooledProvider(p.type);
    if (pool) {
      discovered = await pool.discover({ id: p.id, baseUrl: p.baseUrl, totalTimeoutMs: p.totalTimeoutMs });
    } else {
      if (!p.encryptedApiKey || !p.apiKeyNonce) throw new GatewayError('invalid_request_error', 'Provider credentials are missing', { status: 501 });
      const apiKey = decryptSecret({ ciphertext: p.encryptedApiKey, nonce: p.apiKeyNonce, version: p.apiKeyVersion });
      const headers = decryptCustomHeaders(p.customHeadersEncrypted && p.customHeadersNonce ? { ciphertext: p.customHeadersEncrypted, nonce: p.customHeadersNonce, version: 1 } : null);
      discovered = await discoverProviderModels({
      type: p.type,
      baseUrl: p.baseUrl,
      apiKey,
      customHeaders: headers,
      connectTimeoutMs: 5000,
      totalTimeoutMs: 30000,
      } as never);
    }
    const existing = db
      .select()
      .from(schema.models)
      .where(eq(schema.models.providerId, p.id))
      .all();
    const existingMap = new Map(existing.map((m) => [m.upstreamModelId, m]));
    const enriched = discovered.map((d) => ({
      ...d,
      alreadyImported: existingMap.has(d.upstreamId),
      existingModelId: existingMap.get(d.upstreamId)?.id ?? null,
    }));
    recordAudit({ action: 'provider.discover', success: true, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip, metadata: { count: discovered.length } });
    return { models: enriched };
  });
}
