// Dedicated built-in provider and connection management. The existing
// provider UUID remains the execution/credential boundary, never the slug.
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../../db/index';
import { encryptSecret, isMasterKeyConfigured } from '../../auth/crypto';
import { uuid } from '../../auth/ids';
import { recordAudit } from '../../db/repositories/audit';
import { GatewayError } from '../../errors';
import { BUILTIN_PROVIDERS, assertBuiltinNamespaceAvailable, builtinNamespaceConflicts, providerPublicPrefix } from '../../providers/builtin';
import { providerIntegration } from '../../providers/integration';

const ConnectionCreate = z.object({
  name: z.string().trim().min(1).max(128),
  apiKey: z.string().min(1).max(20000).optional(),
}).strict();

export async function registerBuiltinProviderRoutes(app: FastifyInstance): Promise<void> {
  // Registered inside the authenticated and CSRF-protected provider scope.
  app.get('/api/admin/builtin-providers', async () => {
    const db = getDb();
    const connections = db.select({ provider: schema.providers, connection: schema.providerConnections, integration: schema.providerIntegrations })
      .from(schema.providerConnections)
      .innerJoin(schema.providers, eq(schema.providers.id, schema.providerConnections.providerId))
      .innerJoin(schema.providerIntegrations, eq(schema.providerIntegrations.providerId, schema.providerConnections.providerId)).all();
    const counts = new Map(db.select({ id: schema.models.providerId, count: sql<number>`count(*)` })
      .from(schema.models).groupBy(schema.models.providerId).all().map(r => [r.id, Number(r.count)]));
    // Existing retention-independent provider aggregates are already keyed by
    // the backing connection UUID. These are local upstream attempts, not
    // subscription quota or a count of distinct client requests.
    const usage = new Map(db.select({
      id: schema.dailyProviderStats.providerId,
      requests: sql<number>`coalesce(sum(${schema.dailyProviderStats.attempts}),0)`,
      totalTokens: sql<number>`coalesce(sum(${schema.dailyProviderStats.inputTokens}+${schema.dailyProviderStats.outputTokens}),0)`,
    }).from(schema.dailyProviderStats).groupBy(schema.dailyProviderStats.providerId).all()
      .map(r => [r.id, { requests: Number(r.requests), totalTokens: Number(r.totalTokens) }]));
    return {
      providers: BUILTIN_PROVIDERS.map(builtin => {
        const conflicts = builtinNamespaceConflicts(db, builtin);
        return {
          kind: builtin.kind, name: builtin.name, slug: builtin.slug, authMode: builtin.authMode,
          namespaceAvailable: conflicts.length === 0, conflicts,
          connections: connections.filter(c => c.integration.providerKind === builtin.kind).map(({ provider, connection }) => ({
            id: provider.id, name: provider.name, slug: providerPublicPrefix(db, provider),
            enabled: provider.enabled, health: provider.healthState,
            modelCount: counts.get(provider.id) ?? 0, namespaceMode: connection.namespaceMode,
            authMode: providerIntegration(provider).authMode, createdAt: provider.createdAt, updatedAt: provider.updatedAt,
            usage: usage.get(provider.id) ?? { requests: 0, totalTokens: 0 },
          })),
        };
      }),
    };
  });

  app.post('/api/admin/builtin-providers/:kind/connections', async req => {
    const { kind } = req.params as { kind: string };
    const builtin = BUILTIN_PROVIDERS.find(b => b.kind === kind);
    if (!builtin) throw new GatewayError('invalid_request_error', 'Built-in provider not found', { status: 404 });
    const body = ConnectionCreate.parse(req.body);
    if (builtin.kind === 'codex' && body.apiKey !== undefined) {
      throw new GatewayError('invalid_request_error', 'Codex signs in within the client; server credentials are not supported', { status: 400 });
    }
    if (builtin.kind === 'claude_code' && (!body.apiKey || !/^sk-ant-api[A-Za-z0-9_-]+$/.test(body.apiKey))) {
      throw new GatewayError('invalid_request_error', 'An authorized Anthropic API key is required', { status: 400 });
    }
    if (builtin.kind === 'claude_code' && !isMasterKeyConfigured()) {
      throw new GatewayError('gateway_error', 'Master key not configured', { status: 503 });
    }
    const enc = body.apiKey ? encryptSecret(body.apiKey) : null;
    const id = uuid();
    const db = getDb();
    db.transaction(tx => {
      assertBuiltinNamespaceAvailable(tx, builtin);
      if (builtin.kind === 'codex' && tx.select({ id: schema.providerConnections.providerId })
        .from(schema.providerConnections).innerJoin(schema.providerIntegrations, eq(schema.providerIntegrations.providerId, schema.providerConnections.providerId))
        .where(sql`${schema.providerConnections.namespaceMode}='canonical' AND ${schema.providerIntegrations.providerKind}='codex'`).get()) {
        throw new GatewayError('invalid_request_error', 'A canonical Codex client profile already exists', { status: 409, code: 'builtin_profile_exists' });
      }
      tx.insert(schema.providers).values({
        id, name: body.name, slug: 'builtin-connection-' + id, type: builtin.type, baseUrl: builtin.origin,
        encryptedApiKey: enc?.ciphertext ?? null, apiKeyNonce: enc?.nonce ?? null, apiKeyVersion: enc?.version ?? 1,
      }).run();
      tx.insert(schema.providerIntegrations).values({ providerId: id, providerKind: builtin.kind, authMode: builtin.authMode }).run();
      tx.update(schema.providerConnections).set({ namespaceMode: 'canonical' }).where(eq(schema.providerConnections.providerId, id)).run();
    });
    recordAudit({ action: 'provider.connection.create', success: true, targetType: 'provider', targetId: id, targetName: body.name, ip: req.ip, metadata: { kind: builtin.kind } });
    return { id, slug: builtin.slug };
  });
}
