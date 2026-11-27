// Admin API: combos CRUD + member management.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { uuid } from '../../auth/ids';
import { GatewayError } from '../../errors';
import type { GatewayContext, GatewayRequest } from '../../gateway/runner';
import type { CanonicalRequest } from '../../routing/capabilities';
import { circuitBlocks, modelThrottleBlocks } from '../../routing/circuit';
import { listAdaptiveStates } from '../../routing/combo-adaptive-state';
import { freshSamples, median, SAMPLE_TTL_MS } from '../../routing/combo-policy';
import { assertRoutingNameFree } from '../../routing/namespace';
import { providerPublicPrefix } from '../../providers/builtin';

const MemberSpec = z.object({ modelId: z.string(), position: z.number().int().min(0), enabled: z.boolean().default(true) });

const OptionalSlug = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).max(64).optional(),
);

const ComboCreate = z.object({
  name: z.string().min(1).max(128),
  slug: OptionalSlug,
  comboKind: z.enum(['standard', 'codex_native']).optional(),
  mode: z.literal('fallback').default('fallback'),
  maxTotalAttempts: z.number().int().min(1).max(8).optional(),
  maxRequestDurationSeconds: z.number().int().min(1).max(3600).nullable().optional(),
  enabled: z.boolean().optional(),
  fallbackOnConnection: z.boolean().optional(),
  fallbackOnConnectTimeout: z.boolean().optional(),
  fallbackOnFirstTokenTimeout: z.boolean().optional(),
  fallbackOnTotalTimeout: z.boolean().optional(),
  fallbackOn408: z.boolean().optional(),
  fallbackOn429: z.boolean().optional(),
  fallbackOn5xx: z.boolean().optional(),
  slowResponseFallbackEnabled: z.boolean().optional(),
  slowResponseThresholdSeconds: z.number().int().min(1).max(600).optional(),
  slowResponseMaxCount: z.number().int().min(1).max(20).optional(),
  members: z.array(MemberSpec).min(1).max(16),
});

const ComboUpdate = ComboCreate.partial().extend({ id: z.string() });

// Combo public IDs default to the (normalized) name WITHOUT a prefix — e.g.
// name "gpt-5.5" becomes model id "gpt-5.5". Only when the client explicitly
// supplies a slug does the id get the "combo/" prefix ("combo/<slug>").
// Unlike slugify(), dots are preserved: they are legal in model IDs
// (e.g. "gpt-5.6-sol").
function comboSlug(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[\s/]+/g, '-')
      .replace(/[^a-z0-9._-]+/g, '')
      .slice(0, 64) || 'item'
  );
}

/**
 * A combo's slug and public id both have to be unique, and `slug` is NOT
 * derivable from `public_model_id` (a slugless combo has slug "beta" and id
 * "beta"; a slugged one has slug "beta" and id "combo/beta"). Checking only the
 * public id lets a new name collide with an existing *slug*: the insert then
 * dies as a raw SQLITE_CONSTRAINT and reaches the admin as an opaque
 * 500 "Gateway error".
 */
function assertComboIdFree(db: ComboDb, slug: string, publicModelId: string, excludeId?: string): void {
  const clash = db
    .select()
    .from(schema.combos)
    .where(sql`public_model_id = ${publicModelId} OR slug = ${slug}`)
    .all()
    .find((c) => c.id !== excludeId);
  if (clash) throw new GatewayError('invalid_request_error', 'Combo ID already in use', { status: 400 });
  assertRoutingNameFree(db, publicModelId, 'combo', excludeId);
  if (slug !== publicModelId) assertRoutingNameFree(db, slug, 'combo', excludeId);
}

/** Slug triple the route / slug triple the runtime resolver expects. */
function comboIds(name: string, slug?: string): { slug: string; publicModelId: string } {
  const s = comboSlug(slug || name);
  return { slug: s, publicModelId: slug ? `combo/${s}` : s };
}

/**
 * `combo_members` is UNIQUE(combo_id, model_id) and the admin UI's member rows
 * are the payload of record, so two rows for one model collapse silently. Reject
 * that here: a member list is a set, and telling the operator beats a lost row.
 */
function assertMembersUsable(db: ComboDb, members: Array<{ modelId: string }>, kind: ComboKind): void {
  const ids = members.map((m) => m.modelId);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new GatewayError('invalid_request_error', `Duplicate members: ${[...new Set(dupes)].join(', ')}`, { status: 400 });
  }
  assertModelsExist(db, members);
  const oauthMembers = db.select({ id: schema.models.id, upstreamModelId: schema.models.upstreamModelId }).from(schema.models)
    .innerJoin(schema.providerIntegrations, eq(schema.models.providerId, schema.providerIntegrations.providerId))
    .where(sql`${schema.providerIntegrations.providerKind} = 'codex' AND ${schema.providerIntegrations.authMode} = 'client_oauth' AND ${schema.models.id} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`).all();
  if (kind === 'standard' && oauthMembers.length) throw new GatewayError('invalid_request_error', 'Client OAuth models require a native Codex combo or direct route', { status: 400 });
  if (kind === 'codex_native') {
    if (oauthMembers.length !== members.length) throw new GatewayError('invalid_request_error', 'Native Codex combos require only Codex client OAuth models', { status: 400 });
    if (new Set(oauthMembers.map(m => m.upstreamModelId)).size !== oauthMembers.length) throw new GatewayError('invalid_request_error', 'Native Codex combos require distinct upstream model IDs', { status: 400 });
  }
}

function assertModelsExist(db: ComboDb, members: Array<{ modelId: string }>): void {
  const models = db
    .select()
    .from(schema.models)
    .where(sql`id IN (${sql.join(members.map((m) => sql`${m.modelId}`), sql`, `)})`)
    .all();
  if (models.length !== members.length) {
    throw new GatewayError('invalid_request_error', 'One or more members are not valid physical models', { status: 400 });
  }
}

type ComboDb = ReturnType<typeof getDb>;
type ComboKind = typeof schema.combos.$inferSelect['comboKind'];

function assertComboPolicy(kind: ComboKind, settings: { fallbackOn429?: boolean; slowResponseFallbackEnabled?: boolean }): void {
  if (kind === 'codex_native' && (settings.fallbackOn429 === true || settings.slowResponseFallbackEnabled === true)) {
    throw new GatewayError('invalid_request_error', 'Native Codex combos cannot enable 429 fallback or adaptive slow-response fallback', { status: 400 });
  }
}

const capabilityKeys = ['chat', 'responses', 'streaming', 'tools', 'structured_output', 'image_input', 'audio_input', 'reasoning', 'embeddings'] as const;

function modelCapabilities(model: { capabilitiesJson: string }): Record<string, unknown> {
  try { return JSON.parse(model.capabilitiesJson) as Record<string, unknown>; } catch { return {}; }
}

function memberStatus(model: typeof schema.models.$inferSelect | undefined, provider: typeof schema.providers.$inferSelect | undefined, enabled: boolean, kind: ComboKind, nativeProvider: boolean): { state: 'ready' | 'unavailable'; reason: string } {
  if (!enabled) return { state: 'unavailable', reason: 'member_disabled' };
  if (!model) return { state: 'unavailable', reason: 'model_missing' };
  if (!provider?.enabled) return { state: 'unavailable', reason: 'provider_disabled' };
  if (!model.enabled) return { state: 'unavailable', reason: 'model_disabled' };
  if (!model.upstreamAvailable) return { state: 'unavailable', reason: 'upstream_unavailable' };
  if ((kind === 'codex_native') !== nativeProvider) return { state: 'unavailable', reason: 'provider_integration_mismatch' };
  if (kind === 'codex_native') {
    const caps = modelCapabilities(model);
    if (caps.responses !== true || caps.streaming !== true) return { state: 'unavailable', reason: 'responses_capability_unavailable' };
    // Account availability is only established by the signed-in client. A
    // configured member is eligible, not a globally authenticated provider.
    return { state: 'ready', reason: 'codex_account_unverified' };
  }
  if (circuitBlocks(model.providerId, provider.cbCooldownSeconds) || modelThrottleBlocks(model.id)) return { state: 'unavailable', reason: 'circuit_open' };
  if (modelCapabilities(model).chat === false) return { state: 'unavailable', reason: 'chat_capability_unavailable' };
  return { state: 'ready', reason: provider.healthState === 'degraded' || provider.healthState === 'down' ? 'provider_degraded' : 'ready' };
}

// A model has independent latency histories for each workload. Never expose
// lease owner tokens or imply that one member is preferred for all requests.
function adaptiveStateView(state: ReturnType<typeof listAdaptiveStates>[number], now: number) {
  const values = freshSamples(state.samples, now).map((s) => s.latencyMs);
  const probing = state.probeLeaseUntilMs !== null && state.probeLeaseUntilMs > now;
  const observedAt = state.lastObservationMs ?? state.updatedAtMs;
  const fresh = observedAt <= now && observedAt >= now - SAMPLE_TTL_MS;
  const degraded = fresh || probing ? state.degraded : null;
  return {
    modelId: state.modelId,
    workload: state.workload,
    latencyKind: state.workload.startsWith('stream') ? 'ttft' : 'completion',
    medianLatencyMs: median(values),
    sampleCount: values.length,
    consecutiveSlowCount: state.consecutiveSlowCount,
    relativeSlowCount: state.relativeSlowCount,
    degraded,
    fresh,
    comparatorModelId: state.comparatorModelId,
    probeDueMs: state.probeDueMs,
    probeLeaseUntilMs: state.probeLeaseUntilMs,
    recoverySuccesses: state.recoverySuccesses,
    lastLatencyMs: state.lastLatencyMs,
    lastOutcome: state.lastOutcome,
    updatedAtMs: state.updatedAtMs,
    state: probing ? 'probing' : !fresh ? 'unknown' : degraded ? ((state.probeDueMs ?? 0) <= now ? 'probe_due' : `degraded_${degraded}`) : values.length < 3 ? 'unknown' : state.consecutiveSlowCount || state.relativeSlowCount ? 'suspect' : 'ready',
  };
}

function capabilityWarnings(models: Array<typeof schema.models.$inferSelect>): string[] {
  return capabilityKeys.filter((key) => {
    const values = new Set(models.map((model) => {
      const value = modelCapabilities(model)[key];
      return value === true ? 'yes' : value === false ? 'no' : 'unknown';
    }));
    return values.size > 1;
  });
}

export async function registerComboRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/combos', async () => {
    const db = getDb();
    const combos = db.select().from(schema.combos).all();
    const allMembers = db.select().from(schema.comboMembers).all();
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const providerMap = new Map(db.select().from(schema.providers).all().map((p) => [p.id, p]));
    const nativeProviders = new Set(db.select().from(schema.providerIntegrations).all().filter(i => i.providerKind === 'codex' && i.authMode === 'client_oauth').map(i => i.providerId));
    return {
      combos: combos.map((c) => {
        const members = allMembers.filter((m) => m.comboId === c.id);
        const statuses = members.map((m) => memberStatus(modelMap.get(m.modelId), providerMap.get(modelMap.get(m.modelId)?.providerId ?? ''), m.enabled, c.comboKind, nativeProviders.has(modelMap.get(m.modelId)?.providerId ?? '')));
        const readyCount = statuses.filter((status) => status.state === 'ready').length;
        const reasons = [...new Set(statuses.filter((status) => status.state === 'unavailable').map((status) => status.reason))];
        const comboModels = members.map((m) => modelMap.get(m.modelId)).filter((m): m is typeof models[number] => Boolean(m));
        const now = Date.now();
        const slowStates = c.slowResponseFallbackEnabled ? listAdaptiveStates(c.id).map((state) => adaptiveStateView(state, now)) : [];
        const slowCooldownCount = new Set(slowStates.filter((state) => state.degraded && !(state.probeLeaseUntilMs !== null && state.probeLeaseUntilMs > now)).map((state) => state.modelId)).size;
        const slowProbeCount = new Set(slowStates.filter((state) => state.probeLeaseUntilMs !== null && state.probeLeaseUntilMs > now).map((state) => state.modelId)).size;
        return {
          id: c.id,
          name: c.name,
          slug: c.slug,
          publicModelId: c.publicModelId,
          comboKind: c.comboKind,
          mode: c.mode,
          enabled: c.enabled,
          memberCount: members.length,
          healthyMemberCount: readyCount,
          slowCooldownCount,
          slowProbeCount,
          status: !c.enabled ? 'disabled' : readyCount > 0 ? 'ready' : 'unavailable',
          unavailableReasons: reasons,
          capabilityWarnings: capabilityWarnings(comboModels),
        };
      }),
    };
  });

  app.get('/api/admin/combos/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const c = db.select().from(schema.combos).where(eq(schema.combos.id, id)).get();
    if (!c) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    // The admin UI shows (and drag-reorders) members by priority, so return them
    // in position order rather than relying on SQLite row order.
    const members = db.select().from(schema.comboMembers).where(eq(schema.comboMembers.comboId, id)).all()
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const models = db.select().from(schema.models).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const providers = db.select().from(schema.providers).all();
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const nativeProviders = new Set(db.select().from(schema.providerIntegrations).all().filter(i => i.providerKind === 'codex' && i.authMode === 'client_oauth').map(i => i.providerId));
    const statuses = members.map(m => memberStatus(modelMap.get(m.modelId), providerMap.get(modelMap.get(m.modelId)?.providerId ?? ''), m.enabled, c.comboKind, nativeProviders.has(modelMap.get(m.modelId)?.providerId ?? '')));
    const readyCount = statuses.filter(s => s.state === 'ready').length;
    const now = Date.now();
    const slowStates = c.slowResponseFallbackEnabled ? listAdaptiveStates(id).map((state) => adaptiveStateView(state, now)) : [];
     const comboModels = members.map((m) => modelMap.get(m.modelId));
     return {
      combo: {
        ...c,
        status: !c.enabled ? 'disabled' : readyCount > 0 ? 'ready' : 'unavailable',
        healthyMemberCount: readyCount,
        members: members.map((m, index) => {
          const adaptiveStates = slowStates.filter((state) => state.modelId === m.modelId);
          const latest = [...adaptiveStates].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
          return ({
          id: m.id,
          modelId: m.modelId,
          publicModelId: modelMap.get(m.modelId)?.publicModelId ?? '',
          upstreamModelId: modelMap.get(m.modelId)?.upstreamModelId ?? '',
          displayName: modelMap.get(m.modelId)?.displayName ?? '',
          providerSlug: providerMap.get(modelMap.get(m.modelId)?.providerId ?? '') ? providerPublicPrefix(db, providerMap.get(modelMap.get(m.modelId)?.providerId ?? '')!) : '',
          position: m.position,
          enabled: m.enabled,
           upstreamAvailable: modelMap.get(m.modelId)?.upstreamAvailable ?? false,
           providerEnabled: providerMap.get(modelMap.get(m.modelId)?.providerId ?? '')?.enabled ?? false,
           providerHealth: c.comboKind === 'codex_native' ? 'unknown' : providerMap.get(modelMap.get(m.modelId)?.providerId ?? '')?.healthState ?? 'unknown',
           circuitOpen: c.comboKind !== 'codex_native' && (circuitBlocks(modelMap.get(m.modelId)?.providerId ?? '', providerMap.get(modelMap.get(m.modelId)?.providerId ?? '')?.cbCooldownSeconds ?? 0) || modelThrottleBlocks(m.modelId)),
           capabilities: modelMap.get(m.modelId) ? modelCapabilities(modelMap.get(m.modelId)!) : {},
           status: statuses[index],
          adaptiveStates,
          // Compatibility snapshot for older admin clients. Decisions are scoped
          // to adaptiveStates; this is merely the most recently updated bucket.
          slowState: latest ? {
            modelId: m.modelId, consecutiveSlowCount: latest.consecutiveSlowCount,
            cooldownUntilMs: latest.probeDueMs, probeLeaseUntilMs: latest.probeLeaseUntilMs,
            lastLatencyMs: latest.lastLatencyMs, updatedAtMs: latest.updatedAtMs,
            lastOutcome: latest.lastOutcome === 'success' ? (latest.lastLatencyMs !== null && latest.lastLatencyMs >= c.slowResponseThresholdSeconds * 1000 ? 'slow' : 'fast') : latest.lastOutcome === 'soft_timeout' ? 'slow' : latest.lastOutcome === 'error' ? 'error' : 'unknown',
          } : null,
        }); }),
         capabilityWarnings: capabilityWarnings(comboModels.filter((m): m is typeof models[number] => Boolean(m))),
      },
    };
  });

  app.post('/api/admin/combos/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const combo = db.select().from(schema.combos).where(eq(schema.combos.id, id)).get();
    if (!combo) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    if (combo.comboKind === 'codex_native') throw new GatewayError('invalid_request_error', 'Test native combos from the signed-in Codex client', { status: 400 });

    const { GatewayRunner } = await import('../../gateway/runner');
    const runner = new GatewayRunner();
    const canonicalReq: CanonicalRequest = {
      model: combo.publicModelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Bạn là model gì?' }] }],
      stream: false,
      maxOutputTokens: 256,
      temperature: 0.7,
    };
    const ctx: GatewayContext = {
      requestId: 'combo-test-' + uuid(),
      clientIp: req.ip,
      protocol: 'openai',
      endpoint: 'chat/completions',
      requestedModel: combo.publicModelId,
      key: null,
      synthetic: true,
      reply: { raw: {} } as never,
    };
    const gatewayReq: GatewayRequest = { canonical: canonicalReq, protocol: 'openai', endpoint: 'chat/completions' };
    let outcome: Awaited<ReturnType<typeof runner.execute>>;
    try {
      outcome = await runner.execute(gatewayReq, ctx);
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      throw new GatewayError('gateway_error', (e as Error).message, { cause: e });
    }

    const models = db.select().from(schema.models).all();
    const providers = db.select().from(schema.providers).all();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const selected = outcome.attempts.find((attempt) => attempt.success);
    const selectedModel = selected ? modelMap.get(selected.modelId) : undefined;
    recordAudit({ action: 'combo.test', success: outcome.success, targetType: 'combo', targetId: id, targetName: combo.publicModelId, ip: req.ip });
    return {
      success: outcome.success,
      text: outcome.text ?? '',
      latencyMs: outcome.latencyMs,
      selectedModel: selectedModel ? {
        publicModelId: selectedModel.publicModelId,
        upstreamModelId: selectedModel.upstreamModelId,
        providerSlug: providerMap.get(selectedModel.providerId) ? providerPublicPrefix(db, providerMap.get(selectedModel.providerId)!) : '',
      } : null,
      attempts: outcome.attempts.map((attempt) => {
        const model = modelMap.get(attempt.modelId);
        return {
          publicModelId: model?.publicModelId ?? attempt.modelId,
          upstreamModelId: model?.upstreamModelId ?? '',
          providerName: attempt.providerName,
          latencyMs: attempt.latencyMs,
          success: attempt.success,
          selectionReason: attempt.selectionReason,
          failureReason: attempt.failureReason,
        };
      }),
    };
  });

  app.post('/api/admin/combos', async (req) => {
    const body = ComboCreate.parse(req.body);
    const db = getDb();
    const kind = body.comboKind ?? 'standard';
    // No slug given → the public id IS the normalized name (no "combo/" prefix).
    const { slug, publicModelId } = comboIds(body.name, body.slug);
    // The id must be globally unique across combos AND physical models — the
    // resolver treats every name as one routing surface.
    assertComboIdFree(db, slug, publicModelId);
    assertComboPolicy(kind, body);
    assertMembersUsable(db, body.members, kind);

    const id = uuid();
    // ponytail: one transaction — a combo row without its members is unroutable,
    // and a half-applied create used to burn the name and report only "Gateway error".
    db.transaction((tx) => {
      tx.insert(schema.combos).values({
        id,
        name: body.name,
        slug,
        publicModelId,
        comboKind: kind,
        mode: body.mode,
        enabled: body.enabled ?? true,
        maxTotalAttempts: body.maxTotalAttempts ?? 3,
        maxRequestDurationSeconds: body.maxRequestDurationSeconds ?? null,
        fallbackOnConnection: body.fallbackOnConnection ?? true,
        fallbackOnConnectTimeout: body.fallbackOnConnectTimeout ?? true,
        fallbackOnFirstTokenTimeout: body.fallbackOnFirstTokenTimeout ?? true,
        fallbackOnTotalTimeout: body.fallbackOnTotalTimeout ?? true,
        fallbackOn408: body.fallbackOn408 ?? true,
        fallbackOn429: body.fallbackOn429 ?? (kind === 'standard'),
        fallbackOn5xx: body.fallbackOn5xx ?? true,
        slowResponseFallbackEnabled: body.slowResponseFallbackEnabled ?? (kind === 'standard'),
        slowResponseThresholdSeconds: body.slowResponseThresholdSeconds ?? 60,
        slowResponseMaxCount: body.slowResponseMaxCount ?? 3,
        configVersion: 1,
      }).run();
      for (const m of body.members) {
        tx.insert(schema.comboMembers).values({ id: uuid(), comboId: id, modelId: m.modelId, position: m.position, enabled: m.enabled ?? true }).run();
      }
    });
    recordAudit({ action: 'combo.create', success: true, targetType: 'combo', targetId: id, targetName: body.name, ip: req.ip, metadata: { members: body.members.length, mode: body.mode } });
    return { id, slug, publicModelId };
  });

  app.patch('/api/admin/combos', async (req) => {
    const body = ComboUpdate.parse(req.body);
    const db = getDb();
    const c = db.select().from(schema.combos).where(eq(schema.combos.id, body.id)).get();
    if (!c) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    if (body.comboKind !== undefined && body.comboKind !== c.comboKind) throw new GatewayError('invalid_request_error', 'Combo kind is immutable; create a new combo', { status: 400 });
    assertComboPolicy(c.comboKind, body);
    const update: Partial<typeof schema.combos.$inferInsert> = { updatedAt: new Date().toISOString(), configVersion: c.configVersion + 1 };
    if (body.name) update.name = body.name;
    // Same rule as creation: no slug → the id IS the (normalized) name, slug →
    // combo/<slug>. Deliberately no `|| body.name || c.name` fallback: a request
    // carrying neither field would otherwise re-derive the id from the current
    // name and silently rename the combo (or degrade it to "item").
    if (body.name !== undefined || body.slug !== undefined) {
      const { slug, publicModelId } = comboIds(body.name ?? c.name, body.slug);
      if (slug !== c.slug || publicModelId !== c.publicModelId) {
        assertComboIdFree(db, slug, publicModelId, body.id);
        update.slug = slug;
        update.publicModelId = publicModelId;
      }
    }
    if (body.mode) update.mode = body.mode;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.maxTotalAttempts !== undefined) update.maxTotalAttempts = body.maxTotalAttempts;
    if (body.maxRequestDurationSeconds !== undefined) update.maxRequestDurationSeconds = body.maxRequestDurationSeconds;
    if (body.fallbackOnConnection !== undefined) update.fallbackOnConnection = body.fallbackOnConnection;
    if (body.fallbackOnConnectTimeout !== undefined) update.fallbackOnConnectTimeout = body.fallbackOnConnectTimeout;
    if (body.fallbackOnFirstTokenTimeout !== undefined) update.fallbackOnFirstTokenTimeout = body.fallbackOnFirstTokenTimeout;
    if (body.fallbackOnTotalTimeout !== undefined) update.fallbackOnTotalTimeout = body.fallbackOnTotalTimeout;
    if (body.fallbackOn408 !== undefined) update.fallbackOn408 = body.fallbackOn408;
    if (body.fallbackOn429 !== undefined) update.fallbackOn429 = body.fallbackOn429;
    if (body.fallbackOn5xx !== undefined) update.fallbackOn5xx = body.fallbackOn5xx;
    if (body.slowResponseFallbackEnabled !== undefined) update.slowResponseFallbackEnabled = body.slowResponseFallbackEnabled;
    if (body.slowResponseThresholdSeconds !== undefined) update.slowResponseThresholdSeconds = body.slowResponseThresholdSeconds;
    if (body.slowResponseMaxCount !== undefined) update.slowResponseMaxCount = body.slowResponseMaxCount;
    const slowSettingsChanged = (body.slowResponseFallbackEnabled !== undefined && body.slowResponseFallbackEnabled !== c.slowResponseFallbackEnabled)
      || (body.slowResponseThresholdSeconds !== undefined && body.slowResponseThresholdSeconds !== c.slowResponseThresholdSeconds)
      || (body.slowResponseMaxCount !== undefined && body.slowResponseMaxCount !== c.slowResponseMaxCount)
      || (body.enabled !== undefined && body.enabled !== c.enabled);
    let membersChanged = false;
    let reorderOnly = false;
    let currentMembers: Array<typeof schema.comboMembers.$inferSelect> = [];
    if (body.members) {
      assertMembersUsable(db, body.members, c.comboKind);
      currentMembers = db.select().from(schema.comboMembers).where(eq(schema.comboMembers.comboId, body.id)).all()
        .sort((a, b) => a.position - b.position);
      const requestedByModel = new Map(body.members.map((m) => [m.modelId, m]));
      membersChanged = currentMembers.length !== body.members.length
        || currentMembers.some((member) => {
          const requested = requestedByModel.get(member.modelId);
          return !requested || member.modelId !== requested.modelId || member.position !== requested.position || member.enabled !== requested.enabled;
        });
      reorderOnly = membersChanged && !slowSettingsChanged && currentMembers.length === body.members.length
        && currentMembers.every((member) => requestedByModel.get(member.modelId)?.enabled === member.enabled);
    }
    // Any priority/eligibility change fences in-flight outcomes and leases.
    if (slowSettingsChanged || membersChanged) update.slowResponseGeneration = c.slowResponseGeneration + 1;

    if (membersChanged && body.members) {
      // Retain member IDs. A pure reorder preserves measurements but invalidates
      // decisions, leases and pending outcomes; other changes start fresh.
      db.transaction((tx) => {
        tx.update(schema.combos).set(update).where(eq(schema.combos.id, body.id)).run();
        const requestedById = new Map(body.members!.map((member) => [member.modelId, member]));
        for (const current of currentMembers) {
          if (!requestedById.has(current.modelId)) {
            tx.delete(schema.comboMembers).where(and(
              eq(schema.comboMembers.comboId, body.id),
              eq(schema.comboMembers.modelId, current.modelId),
            )).run();
          }
        }
        for (const m of body.members!) {
          const current = currentMembers.find((member) => member.modelId === m.modelId);
          if (current) {
            tx.update(schema.comboMembers).set({ position: m.position, enabled: m.enabled ?? true })
              .where(eq(schema.comboMembers.id, current.id)).run();
          } else {
            tx.insert(schema.comboMembers).values({ id: uuid(), comboId: body.id, modelId: m.modelId, position: m.position, enabled: m.enabled ?? true }).run();
          }
        }
        if (reorderOnly) {
          tx.update(schema.comboAdaptiveStates).set({ generation: c.slowResponseGeneration + 1,
            degraded: null, comparatorModelId: null, probeDueMs: null, probeLeaseUntilMs: null, probeToken: null,
            consecutiveSlowCount: 0, relativeSlowCount: 0, recoverySuccesses: 0, probeFailures: 0, suspectCount: 0,
            lastStartMs: null, lastStartSequence: 0,
          }).where(eq(schema.comboAdaptiveStates.comboId, body.id)).run();
        } else tx.delete(schema.comboAdaptiveStates).where(eq(schema.comboAdaptiveStates.comboId, body.id)).run();
        tx.delete(schema.comboAdaptiveExploration).where(eq(schema.comboAdaptiveExploration.comboId, body.id)).run();
      });
    } else if (slowSettingsChanged) {
      db.transaction((tx) => {
        tx.update(schema.combos).set(update).where(eq(schema.combos.id, body.id)).run();
        tx.delete(schema.comboAdaptiveStates).where(eq(schema.comboAdaptiveStates.comboId, body.id)).run();
        tx.delete(schema.comboAdaptiveExploration).where(eq(schema.comboAdaptiveExploration.comboId, body.id)).run();
      });
    } else {
      db.update(schema.combos).set(update).where(eq(schema.combos.id, body.id)).run();
    }
    // Invalidate cache for this combo
    const { invalidateCacheFor } = await import('../../caching/store');
    invalidateCacheFor('combo', body.id);
    recordAudit({ action: 'combo.update', success: true, targetType: 'combo', targetId: body.id, targetName: c.name, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/combos/:id/reset-adaptive-state', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const c = db.select().from(schema.combos).where(eq(schema.combos.id, id)).get();
    if (!c) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    db.transaction((tx) => {
      tx.update(schema.combos).set({ slowResponseGeneration: c.slowResponseGeneration + 1 }).where(eq(schema.combos.id, id)).run();
      tx.delete(schema.comboAdaptiveStates).where(eq(schema.comboAdaptiveStates.comboId, id)).run();
      tx.delete(schema.comboAdaptiveExploration).where(eq(schema.comboAdaptiveExploration.comboId, id)).run();
    });
    recordAudit({ action: 'combo.adaptive.reset', success: true, targetType: 'combo', targetId: id, targetName: c.name, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/admin/combos/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const c = db.select().from(schema.combos).where(eq(schema.combos.id, id)).get();
    if (!c) throw new GatewayError('invalid_request_error', 'Combo not found', { status: 404 });
    db.delete(schema.combos).where(eq(schema.combos.id, id)).run();
    const { invalidateCacheFor } = await import('../../caching/store');
    invalidateCacheFor('combo', id);
    recordAudit({ action: 'combo.delete', success: true, targetType: 'combo', targetId: id, targetName: c.name, ip: req.ip });
    return { ok: true };
  });
}
