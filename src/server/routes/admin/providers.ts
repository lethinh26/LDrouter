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
import { probeCodex, codexModels } from '../../providers/codex';
import { listCodexAccountSummaries } from '../../db/repositories/codex-accounts';
import { withCodexCredentials } from '../../providers/codex-refresh';
import { redactString } from '../../security/redact';

const ProviderCreate = z.object({
  name: z.string().min(1).max(128),
  slug: z.string().min(1).max(64).optional(),
  type: z.enum(['openai', 'anthropic', 'codex']),
  baseUrl: z.string().url().max(512),
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
    if (body.type !== 'codex' && !body.apiKey) {
      throw new GatewayError('invalid_request_error', 'API key is required for this provider type', { status: 400 });
    }
    requireMasterKey(); // Need master key to encrypt new credentials
    const db = getDb();
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    const dup = db.select().from(schema.providers).where(eq(schema.providers.slug, slug)).get();
    if (dup) throw new GatewayError('invalid_request_error', `Provider slug '${slug}' is already in use`, { status: 400 });
    const enc = body.apiKey ? encryptSecret(body.apiKey) : null;
    const headersEnc = body.customHeaders ? encryptCustomHeaders(body.customHeaders) : null;
    const id = uuid();
    db.insert(schema.providers).values({
      id,
      name: body.name,
      slug,
      type: body.type,
      baseUrl: body.baseUrl,
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
    recordAudit({ action: 'provider.create', success: true, targetType: 'provider', targetId: id, targetName: body.name, ip: req.ip });
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
    const used = db.select().from(schema.models).where(eq(schema.models.providerId, id)).all();
    if (used.length > 0) {
      // Soft-disable if there are dependent models
      db.update(schema.providers).set({ enabled: false, updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, id)).run();
      recordAudit({ action: 'provider.soft_disable', success: true, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip });
      return { ok: true, softDisabled: true };
    }
    db.delete(schema.providers).where(eq(schema.providers.id, id)).run();
    recordAudit({ action: 'provider.delete', success: true, targetType: 'provider', targetId: id, targetName: p.name, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/providers/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
    if (!p) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
    if (p.type === 'codex') {
      const account = listCodexAccountSummaries(p.id).find((candidate) => candidate.enabled && candidate.healthState !== 'down');
      if (!account) throw new GatewayError('authentication_error', 'No eligible Codex account is configured', { status: 503 });
      const row = getRawDb().prepare('SELECT chatgpt_account_id AS accountId FROM codex_accounts WHERE id=?').get(account.id) as { accountId: string | null } | undefined;
      const result = await withCodexCredentials(account.id, async (credentials) => probeCodex({ baseUrl: p.baseUrl, accountId: row?.accountId ?? '', accessToken: credentials.accessToken, customHeaders: {}, totalTimeoutMs: Math.min(p.totalTimeoutMs, 20000) }));
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
    if (p.type === 'codex') {
      const account = listCodexAccountSummaries(p.id).find((candidate) => candidate.enabled && candidate.healthState !== 'down');
      if (!account) throw new GatewayError('authentication_error', 'No eligible Codex account is configured', { status: 503 });
      const row = getRawDb().prepare('SELECT chatgpt_account_id AS accountId FROM codex_accounts WHERE id=?').get(account.id) as { accountId: string | null } | undefined;
      discovered = await withCodexCredentials(account.id, async (credentials) => codexModels({ baseUrl: p.baseUrl, accountId: row?.accountId ?? '', accessToken: credentials.accessToken, customHeaders: {}, totalTimeoutMs: 30000 }));
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
