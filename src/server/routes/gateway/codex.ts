// Dedicated dual-credential endpoint for OpenAI's documented Codex gateway.
// X-API-Key authenticates to LateDev; Authorization authenticates to OpenAI.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, getDatabaseEpoch, schema } from '../../db/index';
import { requireGatewayKey, keyAllowedForTarget, keyIsActive, keyIpAllowed } from '../../auth/api-key';
import { GatewayError, outcomeError, toOpenAIError } from '../../errors';
import { resolveClientIp } from '../../util/client-ip';
import { resolveRequestedModel, unwrapAlias } from '../../routing/resolver';
import { CODEX_API_PATH, providerIntegration } from '../../providers/integration';
import { checkRpm, acquireConcurrent, releaseConcurrent } from '../../routing/ratelimit';
import { GatewayRunner } from '../../gateway/runner';
import { validateCodexRequest } from '../../gateway/codex';
import { fetchCodexCatalog, compatibleCodexEntries } from '../../gateway/codex-catalog';

const Body = z.object({ model: z.string().min(1).max(256), input: z.array(z.unknown()), stream: z.literal(true) }).passthrough();

function clientAuth(req: FastifyRequest) {
  // Distinct header names are intentional. Never inspect another app's stored
  // login state, accept credentials in query strings, or reuse a gateway key.
  const authorization = req.headers.authorization;
  const accountId = req.headers['chatgpt-account-id'];
  if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(authorization) || authorization.length > 32768 ||
      (accountId !== undefined && (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)))) {
    throw new GatewayError('authentication_error', 'Signed-in Codex credential is required', { status: 401, code: 'codex_client_auth_required' });
  }
  if (typeof req.headers['x-api-key'] !== 'string' || authorization.slice(7) === req.headers['x-api-key']) throw new GatewayError('authentication_error', 'A separate gateway API key is required', { status: 401 });
  return { authorization, ...(accountId ? { accountId } : {}) };
}

/** Match current configured public routes to this caller's account catalog. */
function catalogTargets(key: ReturnType<typeof requireGatewayKey>) {
  const db = getDb();
  const providers = new Map(db.select().from(schema.providers).all().filter(p => p.enabled && providerIntegration(p).authMode === 'client_oauth').map(p => [p.id, p]));
  const models = db.select().from(schema.models).all().filter(m => {
    if (!m.enabled || !m.upstreamAvailable || !providers.has(m.providerId)) return false;
    try {
      const caps = JSON.parse(m.capabilitiesJson);
      return caps.responses !== false && caps.streaming !== false;
    } catch { return false; }
  });
  const modelById = new Map(models.map(m => [m.id, m]));
  const names = models.map(m => ({ name: m.publicModelId, kind: 'model' as const, id: m.id, slugs: [m.upstreamModelId], displayName: m.displayName }));
  const combos = db.select().from(schema.combos).all().filter(c => c.enabled && c.comboKind === 'codex_native');
  const members = db.select().from(schema.comboMembers).all();
  const comboTargets = combos.flatMap(c => {
    const candidates = members.filter(m => m.comboId === c.id && m.enabled).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(m => modelById.get(m.modelId)).filter(m => m !== undefined).filter(m => {
        try { const caps = JSON.parse(m.capabilitiesJson); return caps.responses === true && caps.streaming === true; } catch { return false; }
      });
    if (!candidates.length) return [];
    return [{ name: c.publicModelId, kind: 'combo' as const, id: c.id, slugs: candidates.map(m => m.upstreamModelId), displayName: c.name }];
  });
  const targets: Array<(typeof names)[number] | (typeof comboTargets)[number]> = [...names, ...comboTargets];
  for (const a of db.select().from(schema.modelAliases).all()) {
    const target = a.enabled ? targets.find(t => t.kind === a.targetKind && t.id === a.targetId) : undefined;
    if (target) targets.push({ ...target, name: a.alias });
  }
  return targets.filter(({ name, kind, id }) => {
    const target = resolveRequestedModel(name);
    const actual = unwrapAlias(target);
    return actual.kind === kind && (actual.kind === 'model' ? actual.modelId : actual.comboId) === id && keyAllowedForTarget(key, target);
  });
}

export async function registerCodexRoutes(app: FastifyInstance): Promise<void> {
  const runner = new GatewayRunner();
  app.get(`${CODEX_API_PATH}/models`, async (req, reply) => {
    const key = requireGatewayKey(req, 'x-api-key');
    const auth = clientAuth(req);
    const targets = catalogTargets(key);
    reply.header('cache-control', 'no-store');
    if (!targets.length) return { models: [] };
    const query = z.object({ client_version: z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).parse(req.query);
    if (!checkRpm(key.id, key.rpmLimit).allowed) throw new GatewayError('rate_limit_error', 'Rate limit exceeded (RPM)', { status: 429, code: 'rpm_limit' });
    if (!acquireConcurrent(key.id, key.maxConcurrent)) throw new GatewayError('rate_limit_error', 'Too many concurrent requests', { status: 429, code: 'concurrency_limit' });
    const epoch = getDatabaseEpoch();
    try {
      const catalog = await fetchCodexCatalog(auth, query.client_version);
      if (epoch !== getDatabaseEpoch()) throw new GatewayError('permission_error', 'Database changed during catalog request', { status: 409 });
      const current = getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, key.id)).get();
      if (!current || !keyIsActive(current) || !keyIpAllowed(key.id, resolveClientIp(req))) throw new GatewayError('permission_error', 'Gateway credential no longer permitted', { status: 403 });
      const fresh = catalogTargets({ ...key, allowAllModels: current.allowAllModels });
      const models = fresh.flatMap(t => {
        const entry = t.kind === 'model' ? catalog.find(e => e.slug === t.slugs[0]) : compatibleCodexEntries(catalog, t.slugs)?.[0];
        return entry ? [{ ...entry, slug: t.name, display_name: t.displayName, upgrade: null }] : [];
      });
      return { models };
    } finally { releaseConcurrent(key.id); }
  });

  app.post(`${CODEX_API_PATH}/responses`, async (req, reply) => {
    const key = requireGatewayKey(req, 'x-api-key');
    const auth = clientAuth(req);
    const query = z.object({ client_version: z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).parse(req.query);
    const body = Body.parse(req.body);
    validateCodexRequest(body);
    const ctx = { requestId: String(req.id), clientIp: resolveClientIp(req), protocol: 'openai' as const, endpoint: 'responses', requestedModel: body.model, key, reply, codexAuth: auth, codexClientVersion: query.client_version };
    // Native payload is not converted to Chat Completions or written to content
    // logs. Shared runner still owns ACL, admission, dispatch and accounting.
    try {
      const result = await runner.execute({ canonical: { model: body.model, messages: [], stream: true }, protocol: 'openai', endpoint: 'responses', nativeCodex: body }, ctx);
      if (reply.raw.headersSent || reply.raw.writableEnded) { reply.hijack(); return reply; }
      if (!result.success) return reply.code(result.httpStatus).send(toOpenAIError(outcomeError(result), ctx.requestId));
      throw new GatewayError('upstream_error', 'Codex response did not produce a stream', { status: 502 });
    } catch (error) {
      if (reply.raw.headersSent || reply.raw.writableEnded) { if (!reply.raw.writableEnded) reply.raw.end(); reply.hijack(); return reply; }
      if (error instanceof GatewayError) return reply.code(error.status).send(toOpenAIError(error, ctx.requestId));
      throw error;
    }
  });
}
