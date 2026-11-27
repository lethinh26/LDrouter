// Admin API: providers CRUD + Test Connection + Fetch Models.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, eq, inArray } from 'drizzle-orm';
import { getDb, getDatabaseEpoch, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { encryptSecret, decryptSecret, encryptCustomHeaders, decryptCustomHeaders, isMasterKeyConfigured } from '../../auth/crypto';
import { uuid } from '../../auth/ids';
import { normalizeProviderSlug, assertProviderSlugFree } from '../../routing/namespace';
import { GatewayError } from '../../errors';
import type { Provider } from '../../db/schema';
import { probeProvider, discoverProviderModels, type DiscoveredModel, type ProbeResult } from '../../providers/index';
import { CODEX_ORIGIN, CLAUDE_CODE_ORIGIN, providerIntegration } from '../../providers/integration';
import { connectionNamespaceMode, providerPublicPrefix } from '../../providers/builtin';
import { registerBuiltinProviderRoutes } from './builtin-providers';

const ProviderCreate = z.object({
  // Providers use one encrypted API key and a compatible HTTP endpoint.
  name: z.string().min(1).max(128).optional(),
  slug: z.string().min(1).max(64).optional(),
  type: z.enum(['openai', 'anthropic']),
  providerKind: z.enum(['compatible', 'codex', 'claude_code']).optional(),
  authMode: z.enum(['api_key', 'client_oauth']).optional(),
  baseUrl: z.string().url().max(512).optional(),
  apiKey: z.string().min(1).max(20000).optional(),
  customHeaders: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  connectTimeoutMs: z.number().int().min(100).max(120000).optional(),
  firstTokenTimeoutMs: z.number().int().min(100).max(600000).optional(),
  streamIdleTimeoutMs: z.number().int().min(100).max(900000).optional(),
  totalTimeoutMs: z.number().int().min(1000).max(1800000).optional(),
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
    slug: providerPublicPrefix(getDb(), p),
    type: p.type,
    ...providerIntegration(p),
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
  await registerBuiltinProviderRoutes(app);

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
    const name = body.name;
    const providerKind = body.providerKind ?? 'compatible';
    const authMode = providerKind === 'codex' ? 'client_oauth' : 'api_key';
    const codex = providerKind === 'codex';
    if ((body.authMode !== undefined && body.authMode !== authMode) || (codex && body.type !== 'openai') || (providerKind === 'claude_code' && body.type !== 'anthropic')) {
      throw new GatewayError('invalid_request_error', 'Invalid provider kind, protocol or authentication mode', { status: 400 });
    }
    if (codex && (body.apiKey !== undefined || body.customHeaders !== undefined || (body.baseUrl !== undefined && body.baseUrl !== CODEX_ORIGIN))) {
      throw new GatewayError('invalid_request_error', 'Codex uses the signed-in client credential and a fixed OpenAI destination; stored credentials and custom headers are forbidden', { status: 400 });
    }
    if (providerKind === 'claude_code' && (body.customHeaders !== undefined || (body.baseUrl !== undefined && body.baseUrl !== CLAUDE_CODE_ORIGIN) || (body.apiKey !== undefined && !/^sk-ant-api[A-Za-z0-9_-]+$/.test(body.apiKey)))) {
      throw new GatewayError('invalid_request_error', 'Claude Code requires an Anthropic API key and the official Anthropic destination; subscription OAuth and custom headers are not supported', { status: 400 });
    }
    const baseUrl = codex ? CODEX_ORIGIN : providerKind === 'claude_code' ? CLAUDE_CODE_ORIGIN : body.baseUrl;
    if (!name) throw new GatewayError('invalid_request_error', 'Provider name is required', { status: 400 });
    // apiKey before baseUrl: a compatible provider created without either must be told the
    // credential is missing (the UI always supplies baseUrl from its dialog default).
    if (!codex && !body.apiKey) {
      throw new GatewayError('invalid_request_error', 'API key is required for this provider type', { status: 400 });
    }
    if (!baseUrl) throw new GatewayError('invalid_request_error', 'Base URL is required', { status: 400 });
    if (!codex) requireMasterKey(); // Need master key to encrypt new credentials
    const db = getDb();
    const slug = normalizeProviderSlug(body.slug ?? name);
    assertProviderSlugFree(db, slug);
    const enc = body.apiKey ? encryptSecret(body.apiKey) : null;
    const headersEnc = body.customHeaders ? encryptCustomHeaders(body.customHeaders) : null;
    const id = uuid();
    db.transaction(tx => {
    tx.insert(schema.providers).values({
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
      connectTimeoutMs: body.connectTimeoutMs ?? 60000,
      firstTokenTimeoutMs: body.firstTokenTimeoutMs ?? 60000,
      streamIdleTimeoutMs: body.streamIdleTimeoutMs ?? 300000,
      totalTimeoutMs: body.totalTimeoutMs ?? 600000,
      maxRetries: body.maxRetries ?? 2,
      cbFailureThreshold: body.cbFailureThreshold ?? 5,
      cbCooldownSeconds: body.cbCooldownSeconds ?? 60,
    }).run();
    if (providerKind !== 'compatible') tx.insert(schema.providerIntegrations).values({ providerId: id, providerKind, authMode }).run();
    });
    recordAudit({ action: 'provider.create', success: true, targetType: 'provider', targetId: id, targetName: name, ip: req.ip });
    return { id, slug };
  });

  app.patch('/api/admin/providers', async (req) => {
    const body = ProviderUpdate.parse(req.body);
    const db = getDb();
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, body.id)).get();
    if (!p) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
    const integration = providerIntegration(p);
    const canonical = connectionNamespaceMode(db, p.id) === 'canonical';
    if (canonical && ((body.slug !== undefined && body.slug !== p.slug && body.slug !== providerPublicPrefix(db, p)) || body.apiKey !== undefined)) {
      throw new GatewayError('invalid_request_error', 'Built-in namespace and connection credentials are immutable; add a separate connection instead', { status: 409, code: 'builtin_connection_locked' });
    }
    if ((body.providerKind !== undefined && body.providerKind !== integration.providerKind) || (body.authMode !== undefined && body.authMode !== integration.authMode)) {
      throw new GatewayError('invalid_request_error', 'Provider integration and authentication mode are immutable; create a new provider', { status: 400 });
    }
    if (integration.authMode === 'client_oauth') {
      if (body.apiKey !== undefined || body.customHeaders !== undefined || (body.baseUrl !== undefined && body.baseUrl !== CODEX_ORIGIN)) {
        throw new GatewayError('invalid_request_error', 'Codex destination and credential mode cannot be overridden', { status: 400 });
      }
    } else {
      if (integration.providerKind === 'claude_code' && (body.customHeaders !== undefined || (body.baseUrl !== undefined && body.baseUrl !== CLAUDE_CODE_ORIGIN) || (body.apiKey !== undefined && !/^sk-ant-api[A-Za-z0-9_-]+$/.test(body.apiKey)))) {
        throw new GatewayError('invalid_request_error', 'Claude Code requires an Anthropic API key and the official Anthropic destination', { status: 400 });
      }
      requireMasterKey();
    }
    const update: Partial<typeof schema.providers.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.name) update.name = body.name;
    if (!canonical && body.slug !== undefined && body.slug !== p.slug) {
      const slug = normalizeProviderSlug(body.slug);
      if (slug !== p.slug) {
        if (db.select({ id: schema.models.id }).from(schema.models).where(eq(schema.models.providerId, p.id)).get()) {
          throw new GatewayError('invalid_request_error', 'Provider slug cannot be changed after importing models; existing public model IDs must remain stable', { status: 409, code: 'provider_slug_locked' });
        }
        assertProviderSlugFree(db, slug, p.id);
        update.slug = slug;
      }
    }
    if (body.type !== undefined && body.type !== p.type) {
      throw new GatewayError('invalid_request_error', 'Provider protocol is immutable; create a new provider instead', { status: 400 });
    }
    if (body.baseUrl) update.baseUrl = body.baseUrl;
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
    const models = db.select({ id: schema.models.id }).from(schema.models).where(eq(schema.models.providerId, id)).all();
    const modelIds = models.map((model) => model.id);
    if (modelIds.length > 0 && connectionNamespaceMode(db, p.id) === 'canonical') {
      throw new GatewayError('invalid_request_error', 'Disable this connection instead; removing it would delete bound models and routing permissions', { status: 409, code: 'builtin_connection_in_use' });
    }
    db.transaction((tx) => {
      if (modelIds.length > 0) {
        tx.delete(schema.comboMembers).where(inArray(schema.comboMembers.modelId, modelIds)).run();
        tx.delete(schema.modelAliases).where(sql`target_kind = 'model' AND target_id IN (${sql.join(modelIds.map((modelId) => sql`${modelId}`), sql`, `)})`).run();
        tx.delete(schema.apiKeyModelPermissions).where(sql`target_kind = 'model' AND target_id IN (${sql.join(modelIds.map((modelId) => sql`${modelId}`), sql`, `)})`).run();
        tx.delete(schema.responseCache).where(sql`target_kind = 'model' AND target_id IN (${sql.join(modelIds.map((modelId) => sql`${modelId}`), sql`, `)})`).run();
        tx.delete(schema.models).where(inArray(schema.models.id, modelIds)).run();
      }
      tx.delete(schema.providers).where(eq(schema.providers.id, id)).run();
    });
    recordAudit({ action: 'provider.delete', success: true, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/providers/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
    if (!p) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
    if (providerIntegration(p).authMode === 'client_oauth') return { ok: false, detail: 'Connect with a signed-in Codex client to verify this provider. No server credential is stored.', latencyMs: 0 };
    const epoch = getDatabaseEpoch();
    if (!p.encryptedApiKey || !p.apiKeyNonce) throw new GatewayError('invalid_request_error', 'Provider credentials are missing', { status: 501 });
    const apiKey = decryptSecret({ ciphertext: p.encryptedApiKey, nonce: p.apiKeyNonce, version: p.apiKeyVersion });
    const headers = decryptCustomHeaders(p.customHeadersEncrypted && p.customHeadersNonce ? { ciphertext: p.customHeadersEncrypted, nonce: p.customHeadersNonce, version: 1 } : null);
    const result: ProbeResult = await probeProvider({
      type: p.type,
      providerKind: providerIntegration(p).providerKind,
      baseUrl: p.baseUrl,
      apiKey,
      customHeaders: headers,
      connectTimeoutMs: p.connectTimeoutMs,
      totalTimeoutMs: Math.min(p.totalTimeoutMs, 20000),
    } as never);
    const current = epoch === getDatabaseEpoch() ? getDb().select().from(schema.providers).where(eq(schema.providers.id, id)).get() : undefined;
    if (!current || current.updatedAt !== p.updatedAt || current.encryptedApiKey !== p.encryptedApiKey || current.apiKeyNonce !== p.apiKeyNonce || current.enabled !== p.enabled) {
      throw new GatewayError('invalid_request_error', 'Connection changed during verification; retry the test', { status: 409 });
    }
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
    if (providerIntegration(p).authMode === 'client_oauth') throw new GatewayError('invalid_request_error', 'Codex discovery requires the signed-in client. Import approved model IDs manually, then use the authenticated client catalog.', { status: 400, code: 'client_catalog_required' });
    const epoch = getDatabaseEpoch();
    let discovered: DiscoveredModel[];
    if (!p.encryptedApiKey || !p.apiKeyNonce) throw new GatewayError('invalid_request_error', 'Provider credentials are missing', { status: 501 });
    const apiKey = decryptSecret({ ciphertext: p.encryptedApiKey, nonce: p.apiKeyNonce, version: p.apiKeyVersion });
    const headers = decryptCustomHeaders(p.customHeadersEncrypted && p.customHeadersNonce ? { ciphertext: p.customHeadersEncrypted, nonce: p.customHeadersNonce, version: 1 } : null);
    discovered = await discoverProviderModels({
      type: p.type,
      providerKind: providerIntegration(p).providerKind,
      baseUrl: p.baseUrl,
      apiKey,
      customHeaders: headers,
      connectTimeoutMs: 5000,
      totalTimeoutMs: 30000,
    } as never);
    const current = epoch === getDatabaseEpoch() ? getDb().select().from(schema.providers).where(eq(schema.providers.id, id)).get() : undefined;
    if (!current || current.updatedAt !== p.updatedAt || current.encryptedApiKey !== p.encryptedApiKey || current.apiKeyNonce !== p.apiKeyNonce || current.enabled !== p.enabled) {
      throw new GatewayError('invalid_request_error', 'Connection changed during discovery; retry', { status: 409 });
    }
    const existing = db
      .select()
      .from(schema.models)
      .where(eq(schema.models.providerId, p.id))
      .all();
    const existingMap = new Map(existing.map((m) => [m.upstreamModelId, m]));
    const canonical = connectionNamespaceMode(db, id) === 'canonical';
    const prefix = providerPublicPrefix(db, current);
    const allModels = canonical ? db.select({ publicModelId: schema.models.publicModelId, providerId: schema.models.providerId }).from(schema.models).all() : [];
    const ownerMap = new Map(allModels.map(m => [m.publicModelId, m.providerId]));
    const names = canonical ? new Map(db.select({ id: schema.providers.id, name: schema.providers.name }).from(schema.providers).all().map(row => [row.id, row.name])) : new Map<string, string>();
    const enriched = discovered.map((d) => {
      const owner = ownerMap.get(prefix + '/' + d.upstreamId);
      const boundElsewhere = owner !== undefined && owner !== id;
      return {
      ...d,
      alreadyImported: existingMap.has(d.upstreamId),
      existingModelId: existingMap.get(d.upstreamId)?.id ?? null,
      boundElsewhere,
      boundConnectionName: boundElsewhere ? names.get(owner) ?? null : null,
      };
    });
    recordAudit({ action: 'provider.discover', success: true, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip, metadata: { count: discovered.length } });
    return { models: enriched };
  });
}
