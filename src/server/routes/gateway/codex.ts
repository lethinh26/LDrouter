// Dedicated dual-credential endpoint for OpenAI's documented Codex gateway.
// X-API-Key authenticates to LateDev; Authorization authenticates to OpenAI.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, getDatabaseEpoch, schema } from '../../db';
import { requireGatewayKey, keyAllowedForTarget, keyIsActive, keyIpAllowed } from '../../auth/api-key';
import { GatewayError, outcomeError, toOpenAIError } from '../../errors';
import { resolveClientIp } from '../../util/client-ip';
import { resolveRequestedModel } from '../../routing/resolver';
import { CODEX_API_PATH, CODEX_ORIGIN, providerIntegration } from '../../providers/integration';
import { checkRpm, acquireConcurrent, releaseConcurrent } from '../../routing/ratelimit';
import { GatewayRunner } from '../../gateway/runner';
import { validateCodexRequest } from '../../gateway/codex';

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
  const models = db.select().from(schema.models).all().filter(m => m.enabled && m.upstreamAvailable && providers.has(m.providerId));
  const modelById = new Map(models.map(m => [m.id, m]));
  const names = models.map(m => ({ name: m.publicModelId, model: m }));
  for (const a of db.select().from(schema.modelAliases).all()) {
    const model = a.targetKind === 'model' && a.enabled ? modelById.get(a.targetId) : undefined;
    if (model) names.push({ name: a.alias, model });
  }
  return names.filter(({ name, model }) => {
    const target = resolveRequestedModel(name);
    const actual = target.kind === 'alias' ? target.resolved : target;
    return actual.kind === 'model' && actual.modelId === model.id && keyAllowedForTarget(key, target);
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
      const url = new URL(`${CODEX_ORIGIN}${CODEX_API_PATH}/models`);
      if (query.client_version) url.searchParams.set('client_version', query.client_version);
      let response: Response;
      try {
        response = await fetch(url, { headers: { authorization: auth.authorization, ...(auth.accountId ? { 'ChatGPT-Account-ID': auth.accountId } : {}), accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      } catch { throw new GatewayError('upstream_unavailable', 'Codex catalog connection failed', { status: 502 }); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new GatewayError(response.status === 401 || response.status === 403 ? 'upstream_auth_error' : response.status === 429 ? 'upstream_rate_limit' : 'upstream_error', `Codex catalog HTTP ${response.status}`, { status: [401,403,429].includes(response.status) ? response.status : 502 });
      }
      let catalog: Record<string, unknown>;
      try { catalog = await response.json() as Record<string, unknown>; } catch { throw new GatewayError('upstream_error', 'Invalid Codex catalog', { status: 502 }); }
      if (!catalog || !Array.isArray(catalog.models)) throw new GatewayError('upstream_error', 'Invalid Codex catalog', { status: 502 });
      if (epoch !== getDatabaseEpoch()) throw new GatewayError('permission_error', 'Database changed during catalog request', { status: 409 });
      const current = getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, key.id)).get();
      if (!current || !keyIsActive(current) || !keyIpAllowed(key.id, resolveClientIp(req))) throw new GatewayError('permission_error', 'Gateway credential no longer permitted', { status: 403 });
      const fresh = catalogTargets({ ...key, allowAllModels: current.allowAllModels });
      const models = catalog.models.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || !('slug' in entry) || typeof entry.slug !== 'string') return [];
        return fresh.filter(t => t.model.upstreamModelId === entry.slug).map(t => ({ ...entry, slug: t.name, display_name: t.model.displayName, upgrade: null }));
      });
      return { models };
    } finally { releaseConcurrent(key.id); }
  });

  app.post(`${CODEX_API_PATH}/responses`, async (req, reply) => {
    const key = requireGatewayKey(req, 'x-api-key');
    const auth = clientAuth(req);
    const body = Body.parse(req.body);
    validateCodexRequest(body);
    const ctx = { requestId: String(req.id), clientIp: resolveClientIp(req), protocol: 'openai' as const, endpoint: 'responses', requestedModel: body.model, key, reply, codexAuth: auth };
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
