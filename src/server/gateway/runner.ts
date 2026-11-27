// Gateway execution pipeline: auth -> resolve -> ACL -> limits -> route -> attempt -> persist.

import { getDb, getRawDb, getDatabaseEpoch, schema } from '../db/index';
import { desc, eq } from 'drizzle-orm';
import { GatewayError, clientDisconnectedError } from '../errors';
import { resolveRequestedModel, unwrapAlias } from '../routing/resolver';
import { bareModelName, deriveRequiredCapabilities, describeRejections, firstMissingCapability, type CanonicalRequest, type RejectedMember, type RejectionReason, type RequiredCapabilities } from '../routing/capabilities';
import { loadCombo, selectCandidates, orderCandidates, shouldFallback, type ComboPlan, type CandidateModel } from '../routing/combo';
import { classifyWorkload, pickAdaptiveCandidate, type AdaptiveDecision } from '../routing/combo-policy';
import { beginAdaptiveAttempt, listAdaptiveStates, claimAdaptiveProbe, claimAdaptiveExploration, recordAdaptiveOutcome, releaseAdaptiveProbe } from '../routing/combo-adaptive-state';
import { claimCircuitAttempt, releaseCircuitAttempt, recordSuccess, recordFailure, recordThrottle, recordModelThrottle, modelThrottleBlocks, circuitBlocks } from '../routing/circuit';
import { checkRpm, checkTpm, acquireConcurrent, releaseConcurrent, reconcileTpm } from '../routing/ratelimit';
import { reserveQuota, consumeUsage, type QuotaReservation } from '../routing/quota';
import { keyAllowedForTarget, keyIpAllowed, keyIsActive, type AuthenticatedKey } from '../auth/api-key';
import { providerToUpstreamConfig, callUpstreamNonStreaming, callUpstreamStreaming, upstreamUrl, upstreamHttpError, retryAfterMs, type UpstreamCall } from '../upstream/client';
import { canonicalToOpenAIRequest, openAIResponseToCanonical, extractAssistantText, tokenCount } from '../protocols/canonical';
import { canonicalToAnthropicRequest, anthropicResponseToCanonical } from '../protocols/anthropic';
import { uuid } from '../auth/ids';
import { redactString, redactValue } from '../security/redact';
import { getSettings } from '../db/repositories/settings';
import { buildCacheKey, lookupCache, storeCache, cacheAllowed } from '../caching/store';
import { upsertDailyAggregates } from '../backup/stats';
import { metrics } from '../metrics/registry';
import type { FastifyReply } from 'fastify';
import { emitRequestLogged, emitRequestStarted } from './events';
import { nextRequestCompletionTimestamp } from './request-timestamps';
import { watchDownstreamDisconnect } from './downstream';
import { debugHttp, debugBody, debugUpstream, debugStream, errorLine, getDebugFlags } from '../logging/debug';
import { providerIntegration, CODEX_ORIGIN } from '../providers/integration';
import { hasCodexTokenCap, runCodexStreaming, validateCodexRequest } from './codex';

export interface GatewayContext {
  requestId: string;
  clientIp: string;
  protocol: 'openai' | 'anthropic';
  endpoint: string;
  requestedModel: string;
  key: AuthenticatedKey | null;
  reply: FastifyReply;
  /** Admin diagnostics exercise real routing without training user workload or caching. */
  synthetic?: boolean;
  codexAuth?: { authorization: string; accountId?: string };
}

export interface GatewayRequest {
  canonical: CanonicalRequest;
  protocol: 'openai' | 'anthropic';
  endpoint: 'chat/completions' | 'responses' | 'messages';
  nativeCodex?: Record<string, unknown>;
  nativeMessages?: Record<string, unknown>;
  anthropicHeaders?: Record<string, string>;
}

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

interface GenerationResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  finishReason: string | null;
  reasoning?: string;
  refusal?: string;
  legacyFunctionCall?: { name: string; arguments: string };
  thinkingBlocks?: Array<{ type: 'thinking'; thinking: string; signature?: string }>;
  nativeMessage?: Record<string, unknown>;
}

interface AttemptResult {
  statusCode: number;
  ttftMs: number | null;
  upstreamRequestId: string | null;
  usage: UsageSummary;
  result: GenerationResult;
}

export interface AttemptOutcome {
  attemptNumber: number;
  providerId: string;
  modelId: string;
  providerName: string;
  startedAt: string;
  completedAt: string;
  statusCode: number | null;
  success: boolean;
  latencyMs: number;
  ttftMs: number | null;
  usage: UsageSummary;
  streamStarted: boolean;
  partialResponse: boolean;
  selectionReason: string;
  failureReason: string | null;
  sanitizedError: string | null;
  upstreamRequestId: string | null;
  result?: GenerationResult;
}

export interface GatewayOutcome {
  success: boolean;
  httpStatus: number;
  errorType: string | null;
  errorMessage: string | null;
  /** Specific code (rpm_limit, upstream_http_429, capability_not_supported, …)
   *  so the route layer can reproduce the exact error the runner raised. */
  errorCode: string | null;
  text: string | null;
  reasoning?: string;
  refusal?: string;
  legacyFunctionCall?: GenerationResult['legacyFunctionCall'];
  thinkingBlocks?: GenerationResult['thinkingBlocks'];
  nativeMessage?: Record<string, unknown>;
  toolCalls: Array<{ id: string; name: string; input: unknown }> | null;
  finishReason: string | null;
  usage: UsageSummary;
  ttftMs: number | null;
  latencyMs: number;
  attempts: AttemptOutcome[];
  finalModelId: string | null;
  resolvedTargetKind: string;
  resolvedTargetId: string | null;
  gatewayCacheHit: boolean;
  streamEvents: Array<{ event: string; data: unknown }> | null;
}

export class GatewayRunner {
  async execute(req: GatewayRequest, ctx: GatewayContext): Promise<GatewayOutcome> {
    const start = Date.now();
    const startMono = performance.now();
    let concurrencyAcquired = false;
    let quotaReservation: QuotaReservation | undefined;
    const databaseEpoch = getDatabaseEpoch();
    let estimatedInput = 0;
    let estimatedOutput = 0;
    let tpmReserved = 0;
    let quotaInput = 0;
    let quotaOutput = 0;
    const accountQuota = (reported: UsageSummary, generated: boolean, anthropic = false) => {
      quotaInput += reported.input + (anthropic ? reported.cacheRead + reported.cacheWrite : 0) || (generated ? estimatedInput : 0);
      quotaOutput += reported.output || (generated ? estimatedOutput : 0);
    };

    const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
    const attempts: AttemptOutcome[] = [];

    // --- Resolve model ---
    const target = resolveRequestedModel(req.canonical.model);
    const resolved = unwrapAlias(target);
    let comboPlan: ComboPlan | null = null;
    if (resolved.kind === 'combo') comboPlan = loadCombo(resolved.comboId);
    // docs/13 §9: full resolution chain requested -> alias -> combo/model
    if (getDebugFlags().http) {
      const lines = [`requested=${req.canonical.model}`, `type=${resolved.kind}`];
      if (target.kind === 'alias') lines.push(`viaAlias=${target.alias}`);
      if (resolved.kind === 'model') lines.push(`providerModelId=${resolved.modelId}`, `publicModelId=${resolved.publicModelId}`);
      if (resolved.kind === 'combo') lines.push(`comboId=${resolved.comboId}`, `comboPublicId=${resolved.publicModelId}`);
      debugHttp(ctx.requestId, 'MODEL RESOLVE', lines);
    }

    // --- ACL check ---
    if (ctx.key && !keyAllowedForTarget(ctx.key, target)) throw new GatewayError('permission_error', 'Model not permitted for this API key', { status: 403 });

    const rejectLimit = async (error: GatewayError): Promise<never> => {
      const outcome: GatewayOutcome = {
        success: false, httpStatus: error.status, errorType: error.type,
        errorMessage: error.message, errorCode: error.code, text: null, toolCalls: null,
        finishReason: null, usage, ttftMs: null, latencyMs: Math.round(performance.now() - startMono),
        attempts, finalModelId: null, resolvedTargetKind: resolved.kind,
        resolvedTargetId: this.resolvedId(resolved), gatewayCacheHit: false, streamEvents: null,
      };
      await this.persistRequest(req, ctx, resolved, outcome, usage, attempts, false);
      metrics.requestsTotal.inc({ protocol: req.protocol, status: String(error.status) });
      metrics.requestDuration.observe(outcome.latencyMs, { protocol: req.protocol });
      throw error;
    };

    // A client-owned credential may only travel through a direct Codex model
    // (or its alias). Never use it for a generic provider, cache hit or combo.
    if (req.nativeCodex) {
      if (!ctx.codexAuth || !ctx.key || resolved.kind !== 'model') throw new GatewayError('permission_error', 'Codex requires a client credential and a direct model or alias', { status: 403 });
      validateCodexRequest(req.nativeCodex);
      if (hasCodexTokenCap(ctx.key)) return rejectLimit(new GatewayError('capability_not_supported', 'Codex does not support an enforceable output token cap; use an explicitly uncapped key or an API-key provider', { status: 400, code: 'codex_token_cap_unsupported' }));
    } else if (resolved.kind === 'model') {
      const model = getDb().select().from(schema.models).where(eq(schema.models.id, resolved.modelId)).get();
      const provider = model && getDb().select().from(schema.providers).where(eq(schema.providers.id, model.providerId)).get();
      if (provider && providerIntegration(provider).authMode === 'client_oauth') throw new GatewayError('authentication_error', 'Use the dedicated Codex gateway with the signed-in client credential', { status: 401, code: 'codex_client_auth_required' });
    }

    // --- Limits: RPM / TPM / concurrency / quota ---
    if (ctx.key) {
      const rpm = checkRpm(ctx.key.id, ctx.key.rpmLimit);
      if (!rpm.allowed) {
        metrics.rateLimited.inc({ reason: 'rpm' });
        const err = new GatewayError('rate_limit_error', 'Rate limit exceeded (RPM)', { status: 429, code: 'rpm_limit' });
        if (rpm.retryAfterSeconds && typeof ctx.reply.header === 'function') ctx.reply.header('retry-after', String(rpm.retryAfterSeconds));
        return rejectLimit(err);
      }
      // Apply the cap before caching, admission and conversion to either upstream
      // protocol. A finite token budget must also bound an omitted output limit.
      estimatedInput = estimateTokens(JSON.stringify(req.nativeCodex ?? req.nativeMessages ?? { messages: req.canonical.messages, system: req.canonical.system, tools: req.canonical.tools, responseFormat: req.canonical.responseFormat }));
      const outputCap = ctx.key.maxOutputTokensPerRequest ?? Infinity;
      estimatedOutput = Math.min(req.canonical.maxOutputTokens ?? 1024, outputCap);
      if (req.canonical.maxOutputTokens !== undefined || [ctx.key.maxOutputTokensPerRequest, ctx.key.tpmLimit, ctx.key.dailyTokenLimit, ctx.key.monthlyTokenLimit, ctx.key.totalTokenLimit].some((limit) => limit != null)) {
        req = { ...req, canonical: { ...req.canonical, maxOutputTokens: estimatedOutput } };
      }
      if (req.canonical.reasoning?.budgetTokens && req.canonical.maxOutputTokens !== undefined && req.canonical.reasoning.budgetTokens >= req.canonical.maxOutputTokens) {
        throw new GatewayError('invalid_request_error', 'Thinking budget must be smaller than the effective output token limit', { status: 400 });
      }
      const estimate = estimatedInput + estimatedOutput;
      const quota = reserveQuota(ctx.key.id, ctx.key, estimate);
      if (!quota.result.allowed) {
        metrics.rateLimited.inc({ reason: quota.result.reason ?? 'quota' });
        return rejectLimit(new GatewayError('rate_limit_error', `Quota exceeded (${quota.result.reason})`, { status: 429, code: 'quota_limit' }));
      }
      quotaReservation = quota.reservation;
      if (!acquireConcurrent(ctx.key.id, ctx.key.maxConcurrent)) {
        quotaReservation?.release();
        metrics.rateLimited.inc({ reason: 'concurrency' });
        return rejectLimit(new GatewayError('rate_limit_error', 'Too many concurrent requests', { status: 429, code: 'concurrency_limit' }));
      }
      concurrencyAcquired = true;
      const tpm = checkTpm(ctx.key.id, ctx.key.tpmLimit, estimate);
      if (!tpm.allowed) {
        quotaReservation?.release();
        releaseConcurrent(ctx.key.id);
        metrics.rateLimited.inc({ reason: 'tpm' });
        if (tpm.retryAfterSeconds && typeof ctx.reply.header === 'function') ctx.reply.header('retry-after', String(tpm.retryAfterSeconds));
        return rejectLimit(new GatewayError('rate_limit_error', 'Rate limit exceeded (TPM)', { status: 429, code: 'tpm_limit' }));
      }
      tpmReserved = estimate;
    }

    metrics.activeRequests.inc();
    const requestAbort = new AbortController();
    let deadlineAt = Infinity;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const tightenDeadline = (plan: ComboPlan | null) => {
      if (plan?.maxRequestDurationSeconds == null) return;
      const next = startMono + plan.maxRequestDurationSeconds * 1000;
      if (next >= deadlineAt) return;
      deadlineAt = next;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) requestAbort.abort(overallDeadlineError());
      else deadlineTimer = setTimeout(() => requestAbort.abort(overallDeadlineError()), remaining);
    };
    tightenDeadline(comboPlan);
    const response = ctx.reply.raw;
    const detachDownstream = typeof response.on === 'function' && typeof response.off === 'function'
      ? watchDownstreamDisconnect(response, () => requestAbort.abort(clientDisconnectedError()))
      : undefined;
    const abortError = (): GatewayError | null => {
      if (requestAbort.signal.aborted) return requestAbort.signal.reason as GatewayError;
      if (performance.now() >= deadlineAt) {
        const error = overallDeadlineError();
        requestAbort.abort(error);
        return error;
      }
      return null;
    };
    try {
      // --- Capability requirements ---
      const required = { ...deriveRequiredCapabilities(req.canonical), ...(req.nativeCodex ? { responses: true } : {}) };
      debugHttp(ctx.requestId, 'CAPABILITIES REQUIRED', [
        `tools=${required.tools}`,
        `stream=${required.streaming}`,
        `vision=${required.imageInput}`,
        `reasoning=${required.reasoning}`,
        `json=${required.structuredOutput}`,
        `structuredOutput=${required.structuredOutput}`,
        `parallelToolCalls=undefined(derived-from-request-not-gated)`,
        `audioInput=${required.audioInput}`,
      ]);

      // --- Determine candidates ---
      let candidates: CandidateModel[] = [];
      const rejected: RejectedMember[] = [];
      if (resolved.kind === 'model') {
        const loaded = this.loadModelCandidate(resolved.modelId, required, ctx.requestId);
        candidates = loaded.candidates;
        rejected.push(...loaded.rejected);
      } else if (comboPlan) {
        // A disabled combo is a configuration decision, not a routing failure:
        // say so instead of blaming its members for not being available.
        if (!resolved.enabled) {
          const s = describeRejections({ kind: 'combo', publicModelId: resolved.publicModelId }, [{ publicModelId: resolved.publicModelId, reason: 'combo_disabled' }]);
          throw new GatewayError(s.type, s.message, { status: s.status, code: s.type });
        }
        const all = this.loadAllModels();
        const filtered = selectCandidates(comboPlan, all, required, (c, reason) => {
          rejected.push({ publicModelId: c.publicModelId, reason });
          debugHttp(ctx.requestId, 'CAPABILITY REJECT', [`model=${c.publicModelId}`, `reason=${reason}`]);
        });
        // Slow/degraded members remain hard eligible: they may serve as reserves.
        const eligibleFiltered = filtered;
        // docs/13 §10: always report why EACH member was filtered out
        debugHttp(ctx.requestId, 'CANDIDATE FILTER', [
          `comboMembers=${comboPlan.members.length}`,
          `afterFilter=${eligibleFiltered.length}`,
          `rejectedCount=${rejected.length}`,
          ...rejected.map((r) => `rejected: ${r.publicModelId} reason=${r.reason}`),
        ]);
        if (eligibleFiltered.length === 0) {
          const s = describeRejections({ kind: 'combo', publicModelId: resolved.publicModelId }, rejected);
          throw new GatewayError(s.type, s.message, { status: comboPlan.slowResponseFallbackEnabled && s.type === 'upstream_unavailable' ? 503 : s.status, code: s.type });
        }
        candidates = orderCandidates(comboPlan, eligibleFiltered);
        debugHttp(ctx.requestId, 'CANDIDATES ORDERED', [
          `mode=${comboPlan.mode}`,
          ...candidates.map((c, i) => `candidate[${i}]: providerModelId=${c.modelId} publicModelId=${c.publicModelId}`),
        ]);
      }

      if (candidates.length === 0) {
        const s = describeRejections({ kind: 'model', publicModelId: resolved.publicModelId }, rejected);
        throw new GatewayError(s.type, s.message, { status: s.status, code: s.type });
      }

      // --- Gateway response cache check ---
      const settings = getSettings();
      const keyCacheOverride = ctx.key?.cacheOverrideEnabled ?? null;
      const targetCacheOverride = this.getTargetCacheOverride(resolved);
      const nativeProviderIds = new Set(getDb().select().from(schema.providerIntegrations).all().filter(i => i.providerKind === 'claude_code').map(i => i.providerId));
      const allowed = !ctx.synthetic && !req.nativeCodex && !(req.nativeMessages && candidates.some(c => nativeProviderIds.has(c.providerId))) && cacheAllowed({
        globalEnabled: settings.gatewayCacheEnabled,
        keyAllowed: keyCacheOverride,
        targetAllowed: targetCacheOverride,
        streaming: req.canonical.stream,
      });
      if (allowed && !req.canonical.stream && !hasTools(req.canonical)) {
        const cancelled = abortError();
        if (cancelled) throw cancelled;
        const configVersion = this.getTargetConfigVersion(resolved);
        const cacheKey = buildCacheKey({
          protocol: req.protocol,
          resolvedTargetKind: resolved.kind,
          resolvedTargetId: this.resolvedId(resolved),
          configVersion,
          canonicalRequest: req.canonical,
        });
        const cached = lookupCache(cacheKey);
        if (cached.hit && cached.payload) {
          const g = this.cachedToOutcome(cached.payload, cached.usage, ctx, resolved, start);
          if (isEmptyGeneration(g.usage, { text: g.text ?? '', toolCalls: g.toolCalls ?? [] })) {
            // An older gateway may have cached a metadata-only HTTP 200 as a success.
            // Evict that stale entry so the live provider can retry/fallback normally.
            getDb().delete(schema.responseCache).where(eq(schema.responseCache.cacheKey, cacheKey)).run();
          } else {
            if (ctx.key) {
              const cachedInput = g.usage.input || estimatedInput;
              const cachedOutput = g.usage.output || estimatedOutput;
              const quota = quotaReservation?.resize(ctx.key, cachedInput + cachedOutput);
              if (quota && !quota.allowed) {
                metrics.rateLimited.inc({ reason: quota.reason ?? 'quota' });
                return await rejectLimit(new GatewayError('rate_limit_error', `Quota exceeded (${quota.reason})`, { status: 429, code: 'quota_limit' }));
              }
              quotaInput = cachedInput;
              quotaOutput = cachedOutput;
            }
            metrics.cacheHits.inc();
            await this.persistRequest(req, ctx, resolved, g, usageFromCache(cached.usage), attempts, true);
            return g;
          }
        }
        // remember cacheKey for storing after success
        (req as unknown as { _cacheKey?: string; _cacheConfigVersion?: number })._cacheKey = cacheKey;
        (req as unknown as { _cacheKey?: string; _cacheConfigVersion?: number })._cacheConfigVersion = configVersion;
      }

      // --- Attempt loop with fallback ---
      const firstProvider = getDb().select().from(schema.providers).where(eq(schema.providers.id, candidates[0]!.providerId)).get();
      let maxAttempts = comboPlan?.maxTotalAttempts ?? (1 + (firstProvider?.maxRetries ?? 0));
      let lastError: GatewayError | null = null;
      let resultText = '';
      let resultToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      let resultFinishReason: string | null = null;
      let resultExtensions: Pick<GenerationResult, 'reasoning' | 'refusal' | 'thinkingBlocks' | 'legacyFunctionCall' | 'nativeMessage'> = {};
      let finalModelId: string | null = null;
      let completedSuccessfully = false;

      let attemptNumber = 0;
      const workload = classifyWorkload(req.canonical);
      const attempted = new Set<string>();
      const softTimedOut = new Set<string>();
      const softTimedOutMembers = new Map<string, string | undefined>();
      const hardFailed = new Set<string>();
      const skipped = new Set<string>();
      const blockedProbes = new Set<string>();
      let replayed = false;
      let allowExploration = !ctx.synthetic;
      let pendingRetry: CandidateModel | null = null;
      const retriesByModel = new Map<string, number>();
      while (attemptNumber < maxAttempts) {
        const cancelled = abortError();
        if (cancelled) { lastError = cancelled; break; }
        // Configuration and provider state can change while an earlier attempt
        // is in flight. Re-read them before choosing every actual dispatch.
        if (resolved.kind === 'combo') {
          const fresh = loadCombo(resolved.comboId);
          if (!fresh || fresh.enabled === false) {
            lastError = new GatewayError('upstream_unavailable', 'Combo is no longer available', { status: 503 });
            break;
          }
          comboPlan = fresh;
          maxAttempts = Math.min(maxAttempts, fresh.maxTotalAttempts);
          tightenDeadline(fresh);
          if (attemptNumber >= maxAttempts) break;
          if (lastError && !shouldRetryAttempt(fresh, lastError)) break;
          candidates = orderCandidates(fresh, selectCandidates(fresh, this.loadAllModels(), required));
          // A deleted/re-added membership cannot inherit a prior soft timeout.
          for (const [modelId, memberId] of softTimedOutMembers) {
            if (!fresh.members.some((m) => m.modelId === modelId && m.id === memberId && m.enabled)) softTimedOut.delete(modelId);
          }
        } else {
          candidates = this.loadModelCandidate(resolved.modelId, required, ctx.requestId).candidates;
        }
        if (ctx.key) {
          const currentKey = getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, ctx.key.id)).get();
          const currentAlias = target.kind === 'alias' ? getDb().select().from(schema.modelAliases).where(eq(schema.modelAliases.id, target.aliasId)).get() : null;
          if (!currentKey || !keyIsActive(currentKey) || !keyIpAllowed(ctx.key.id, ctx.clientIp)
            || (target.kind === 'alias' && (!currentAlias?.enabled || currentAlias.targetKind !== resolved.kind || currentAlias.targetId !== this.resolvedId(resolved)))
            || !keyAllowedForTarget({ ...ctx.key, allowAllModels: currentKey.allowAllModels }, target)) {
            lastError = new GatewayError('permission_error', 'Model no longer permitted for this API key', { status: 403 });
            break;
          }
          if (req.nativeCodex && hasCodexTokenCap(currentKey)) {
            lastError = new GatewayError('capability_not_supported', 'Codex cannot enforce the configured token cap', { status: 400, code: 'codex_token_cap_unsupported' });
            break;
          }
          // A retry/fallback is another upstream attempt. Include already spent
          // tokens in its reservation so known failed usage cannot bypass quota.
          const requiredTokens = quotaInput + quotaOutput + estimatedInput + estimatedOutput;
          const quota = quotaReservation?.resize(currentKey, requiredTokens);
          if (quota && !quota.allowed) {
            metrics.rateLimited.inc({ reason: quota.reason ?? 'quota' });
            lastError = new GatewayError('rate_limit_error', `Quota exceeded (${quota.reason})`, { status: 429, code: 'quota_limit' });
            break;
          }
          if (requiredTokens > tpmReserved) {
            const extra = checkTpm(ctx.key.id, ctx.key.tpmLimit, requiredTokens - tpmReserved);
            if (!extra.allowed) {
              metrics.rateLimited.inc({ reason: 'tpm' });
              lastError = new GatewayError('rate_limit_error', 'Rate limit exceeded (TPM)', { status: 429, code: 'tpm_limit' });
              if (extra.retryAfterSeconds && typeof ctx.reply.header === 'function') ctx.reply.header('retry-after', String(extra.retryAfterSeconds));
              break;
            }
            tpmReserved = requiredTokens;
          }
        }
        const afterRefresh = abortError();
        if (afterRefresh) { lastError = afterRefresh; break; }
        const eligible = candidates.filter((c) => !skipped.has(c.modelId));
        const adaptive = comboPlan?.slowResponseFallbackEnabled === true;
        const comparableCandidates = eligible.filter((c) => !hardFailed.has(c.modelId));
        const retry: CandidateModel | undefined = pendingRetry === null ? undefined : eligible.find((c) => c.modelId === pendingRetry!.modelId && c.comboMemberId === pendingRetry!.comboMemberId);
        pendingRetry = null;
        const decision: AdaptiveDecision | null = retry
          ? { candidate: retry, role: 'normal' as const, reason: 'retry_empty_response', softTimeout: false }
          : adaptive && comboPlan
            ? pickAdaptiveCandidate({
                candidates: comparableCandidates,
                plan: comboPlan,
                states: listAdaptiveStates(comboPlan.comboId, workload),
                attempted,
                actualAttempts: attemptNumber,
                softTimedOut,
                replayed,
                now: Date.now(),
                blockedProbes: ctx.synthetic ? new Set(comparableCandidates.map((c) => c.modelId)) : blockedProbes,
                allowExploration,
              })
            : (() => {
                const candidate = eligible.find((c) => !attempted.has(c.modelId));
                return candidate ? { candidate, role: 'normal' as const, reason: comboPlan ? (attemptNumber ? 'fallback_after_error' : 'priority') : 'direct_model', softTimeout: false } : null;
              })();
        if (!decision) break;
        const { candidate, role }: Pick<AdaptiveDecision, 'candidate' | 'role'> = decision;
        const provider = getDb().select().from(schema.providers).where(eq(schema.providers.id, candidate.providerId)).get();
        if (!provider || !provider.enabled) {
          skipped.add(candidate.modelId);
          debugHttp(ctx.requestId, 'ATTEMPT SKIP', [`model=${candidate.publicModelId} reason=skipped_disabled_provider`]);
          continue;
        }
        let baseCfg: ReturnType<typeof providerToUpstreamConfig>;
        try {
          const integration = providerIntegration(provider);
          if (req.nativeCodex) {
            if (integration.authMode !== 'client_oauth' || !ctx.codexAuth) throw new GatewayError('permission_error', 'Codex credentials are not permitted for this provider', { status: 403 });
            maxAttempts = 1;
            baseCfg = { type: 'openai', baseUrl: CODEX_ORIGIN, customHeaders: {}, codexAuth: ctx.codexAuth,
              connectTimeoutMs: provider.connectTimeoutMs, firstTokenTimeoutMs: provider.firstTokenTimeoutMs,
              streamIdleTimeoutMs: provider.streamIdleTimeoutMs, totalTimeoutMs: provider.totalTimeoutMs };
          } else {
            if (integration.authMode === 'client_oauth') throw new GatewayError('authentication_error', 'Client OAuth provider requires the dedicated Codex route', { status: 401 });
            baseCfg = providerToUpstreamConfig(provider);
            if (integration.providerKind === 'claude_code') {
              if (!baseCfg.apiKey || !/^sk-ant-api[A-Za-z0-9_-]+$/.test(baseCfg.apiKey)) throw new GatewayError('authentication_error', 'Claude Code requires an Anthropic API key', { status: 400 });
              baseCfg = { ...baseCfg, nativeClaude: true, customHeaders: { 'anthropic-version': '2023-06-01', ...req.anthropicHeaders } };
            }
          }
        }
        catch (e) {
          const error = e instanceof GatewayError ? e : new GatewayError('upstream_error', (e as Error).message, { cause: e });
          // Credential/configuration failures before any upstream dispatch are
          // preflight errors. Admin test endpoints must return the actionable
          // HTTP error, rather than a successful envelope with zero attempts.
          if (attemptNumber === 0) throw error;
          lastError = error;
          break;
        }
        const circuitPermit = claimCircuitAttempt(provider.id, provider.cbCooldownSeconds);
        if (!circuitPermit) {
          skipped.add(candidate.modelId);
          debugHttp(ctx.requestId, 'ATTEMPT SKIP', [`model=${candidate.publicModelId} reason=circuit_open`]);
          continue;
        }
        const attemptPlan = comboPlan;
        const threshold = attemptPlan?.slowResponseThresholdMs ?? 60_000;
        const remainingMs = deadlineAt - performance.now();
        const softTimeout = adaptive && decision.softTimeout && role !== 'replay'
          && attemptNumber + 1 < maxAttempts && remainingMs > threshold
          && baseCfg.totalTimeoutMs > threshold;
        const cfg = { ...baseCfg, requestSignal: requestAbort.signal, ...(softTimeout ? { slowResponseTimeoutMs: threshold } : {}) };
        let probeToken: string | null = null;
        let claimOk = false;
        try {
          if (adaptive && attemptPlan && !ctx.synthetic) {
            if (role === 'probe') {
              probeToken = claimAdaptiveProbe(attemptPlan, candidate, workload, Date.now(), Math.min(baseCfg.totalTimeoutMs, remainingMs) + 30_000);
              if (!probeToken) {
                blockedProbes.add(candidate.modelId);
                continue;
              }
            } else if (role === 'explore') {
              if (!claimAdaptiveExploration(attemptPlan, workload, Date.now())) {
                allowExploration = false;
                continue;
              }
              allowExploration = false;
            }
          }
          claimOk = true;
        } finally {
          // Failed claims must roll back the provider half-open token before re-picking.
          if (!claimOk) releaseCircuitAttempt(provider.id, circuitPermit);
        }
        const beforeDispatch = abortError();
        if (beforeDispatch) {
          try {
            if (probeToken && attemptPlan) releaseAdaptiveProbe(attemptPlan, candidate, workload, probeToken);
          } finally { releaseCircuitAttempt(provider.id, circuitPermit); }
          lastError = beforeDispatch;
          break;
        }
        let attemptFence: ReturnType<typeof beginAdaptiveAttempt> | null = null;
        try {
          if (adaptive && !ctx.synthetic) attemptFence = beginAdaptiveAttempt();
        } catch (e) {
          try {
            if (probeToken && attemptPlan) releaseAdaptiveProbe(attemptPlan, candidate, workload, probeToken);
          } finally { releaseCircuitAttempt(provider.id, circuitPermit); }
          throw e;
        }
        attemptNumber++;
        if (attemptNumber > 1 && finalModelId !== candidate.modelId) metrics.fallbackCount.inc();
        if (adaptive && !ctx.synthetic) metrics.adaptiveDecisions.inc({ reason: decision.reason });
        attempted.add(candidate.modelId);
        if (role === 'replay') replayed = true;
        finalModelId = candidate.modelId;
        const attemptStart = Date.now();
        const attemptStartMono = performance.now();
        // docs/13 §11–§12: provider + upstream request summary
        const upstreamModel = candidate.upstreamModelId;
        debugHttp(ctx.requestId, 'ATTEMPT', [
          `attempt=${attemptNumber}/${maxAttempts}`,
          `provider=${provider.name}`,
          `providerId=${provider.id}`,
          `model=${candidate.publicModelId}`,
          `upstreamModel=${upstreamModel}`,
          `upstreamType=${cfg.type}`,
          `baseUrl=${cfg.baseUrl}`,
          `stream=${req.canonical.stream}`,
          `slowResponseTimeoutMs=${cfg.slowResponseTimeoutMs ?? 'disabled'}`,
          `providerKeyFingerprint=${cfg.codexAuth ? 'client-owned' : apiKeyFingerprint(cfg.apiKey ?? '')}`,
        ]);
        const attempt: AttemptOutcome = {
          attemptNumber,
          providerId: provider.id,
          modelId: candidate.modelId,
          providerName: provider.name,
          startedAt: new Date(attemptStart).toISOString(),
          completedAt: '',
          statusCode: null,
          success: false,
          latencyMs: 0,
          ttftMs: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
          streamStarted: false,
          partialResponse: false,
          selectionReason: decision.reason,
          failureReason: null,
          sanitizedError: null,
          upstreamRequestId: null,
        };

        const learnOutcome = (kind: 'success' | 'soft_timeout' | 'error' | 'cancel', latencyMs: number | null) => {
          if (!adaptive || !attemptPlan || !attemptFence || ctx.synthetic) return;
          metrics.adaptiveOutcomes.inc({ role, result: kind });
          try {
            const currentlyComparable = selectCandidates(attemptPlan, this.loadAllModels(), required)
              .filter((c) => !hardFailed.has(c.modelId) && !skipped.has(c.modelId));
            recordAdaptiveOutcome({
              plan: attemptPlan, candidate, workload, startedAtMs: attemptStart, now: Date.now(),
              kind, latencyMs, role, probeToken, comparableCandidates: currentlyComparable, learn: true, attemptFence,
            });
          } catch (e) {
            // Learning failure must never duplicate an upstream request or turn
            // a delivered result into an error.
            errorLine(ctx.requestId, 'ADAPTIVE STATE ERROR', [redactString((e as Error).message)]);
          }
        };
        try {
          const out = await this.runOneAttempt(req, ctx, candidate, cfg, (isStreamStarted) => {
            attempt.streamStarted = isStreamStarted;
          }, (ttftMs) => {
            attempt.ttftMs = ttftMs;
            // Live signal for the monitoring dashboard: the request is now
            // being served by this provider (lit up from TTFT until the
            // completion event fires on persist).
            emitRequestStarted(ctx.requestId, provider.id, candidate.modelId, ctx.requestedModel, ttftMs);
          });
          const attemptLatencyMs = Math.round(performance.now() - attemptStartMono);
          const cancelled = req.canonical.stream && attempt.streamStarted ? null : abortError();
          if (cancelled) throw new GatewayError(cancelled.type, cancelled.message, { status: cancelled.status, code: cancelled.code, cause: { usage: out.usage } });
          attempt.statusCode = (out as { statusCode?: number | null }).statusCode ?? null;
          attempt.success = true;
          completedSuccessfully = true;
          // A fallback that succeeded answered the client 200: the earlier failed
          // attempt must not keep the request logged (and reported) as a failure.
          lastError = null;
          attempt.latencyMs = attemptLatencyMs;
          attempt.ttftMs = out.ttftMs;
          attempt.usage = out.usage;
          attempt.upstreamRequestId = out.upstreamRequestId;
          attempt.completedAt = new Date().toISOString();
          attempt.result = out.result;
          usage.input += out.usage.input;
          usage.output += out.usage.output;
          usage.cacheRead += out.usage.cacheRead;
          usage.cacheWrite += out.usage.cacheWrite;
          usage.reasoning += out.usage.reasoning;
          usage.total += out.usage.total;
          if (ctx.key) accountQuota(out.usage, true, cfg.type === 'anthropic');
          resultText = out.result.text;
          resultToolCalls = out.result.toolCalls;
          resultFinishReason = out.result.finishReason;
          resultExtensions = { reasoning: out.result.reasoning, refusal: out.result.refusal, thinkingBlocks: out.result.thinkingBlocks, legacyFunctionCall: out.result.legacyFunctionCall, nativeMessage: out.result.nativeMessage };
          // A streaming TTFT is a successful sample only after the stream has
          // completed; non-streaming samples measure the entire valid response.
          learnOutcome('success', req.canonical.stream ? out.ttftMs : attemptLatencyMs);
          if (recordSuccess(provider.id, circuitPermit)) {
            try {
              getDb().update(schema.providers).set({ healthState: 'healthy', updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, provider.id)).run();
            } catch (e) { errorLine(ctx.requestId, 'PROVIDER HEALTH UPDATE ERROR', [redactString((e as Error).message)]); }
          }
          attempts.push(attempt);
          break;
        } catch (e) {
          const err = e instanceof GatewayError ? e : new GatewayError('upstream_error', (e as Error).message, { cause: e });
          const cancelled = err.code === 'client_disconnected' || err.code === 'combo_overall_timeout';
          if (err.code === 'combo_slow_response_timeout') {
            softTimedOut.add(candidate.modelId);
            softTimedOutMembers.set(candidate.modelId, candidate.comboMemberId);
            learnOutcome('soft_timeout', threshold);
          } else {
            hardFailed.add(candidate.modelId);
            learnOutcome(cancelled ? 'cancel' : 'error', null);
          }
          debugUpstream(ctx.requestId, 'ATTEMPT ERROR', [
            `attempt=${attemptNumber}`,
            `provider=${provider.name}`,
            `model=${candidate.publicModelId}`,
            `type=${err.type}`,
            `status=${err.status}`,
            `willFallback=${shouldRetryAttempt(comboPlan, err)}`,
          ]);
          const shouldRetry = shouldRetryAttempt(comboPlan, err);
          attempt.statusCode = err.status;
          attempt.success = false;
          attempt.latencyMs = Math.round(performance.now() - attemptStartMono);
          attempt.completedAt = new Date().toISOString();
          attempt.failureReason = classifyFailure(err);
          attempt.sanitizedError = redactString(err.message);
          const failedRequestId = (err.cause as { upstreamRequestId?: unknown } | undefined)?.upstreamRequestId;
          if (typeof failedRequestId === 'string') attempt.upstreamRequestId = failedRequestId;
          // A malformed 200 response may still report real input tokens. Preserve that
          // usage on the failed attempt and request instead of discarding it on throw.
          const failedUsage = (err.cause as { usage?: UsageSummary } | undefined)?.usage;
          if (failedUsage) {
            const normalizedFailedUsage = {
              ...failedUsage,
              total: failedUsage.total || failedUsage.input + failedUsage.output,
            };
            attempt.usage = normalizedFailedUsage;
            usage.input += normalizedFailedUsage.input;
            usage.output += normalizedFailedUsage.output;
            usage.cacheRead += normalizedFailedUsage.cacheRead;
            usage.cacheWrite += normalizedFailedUsage.cacheWrite;
            usage.reasoning += normalizedFailedUsage.reasoning;
            usage.total += normalizedFailedUsage.total;
          }
          if (ctx.key) accountQuota(attempt.usage, attempt.streamStarted, cfg.type === 'anthropic');
          if (!req.nativeCodex && isUpstreamHealthFailure(err) && recordFailure(provider.id, provider.cbFailureThreshold, provider.cbCooldownSeconds, circuitPermit)) {
            try {
              getDb().update(schema.providers).set({ healthState: 'down', updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, provider.id)).run();
            } catch (e) { errorLine(ctx.requestId, 'PROVIDER HEALTH UPDATE ERROR', [redactString((e as Error).message)]); }
          }
          const retryAfter = (err.cause as { retryAfterMs?: number } | undefined)?.retryAfterMs;
          if (!req.nativeCodex && typeof retryAfter === 'number' && classifyFailure(err) === 'http_status'
            && (err.cause as { status?: number } | undefined)?.status === 429) {
            if (isModelScopedFailure(err)) recordModelThrottle(candidate.modelId, retryAfter, { providerId: provider.id, permit: circuitPermit });
            else recordThrottle(provider.id, retryAfter, circuitPermit);
          }
          // The caller is gone; stop the combo rather than spending attempts on
          // fallback members that cannot deliver a response to anyone.
          if (cancelled) {
            attempt.partialResponse = attempt.streamStarted;
            attempts.push(attempt);
            lastError = err;
            break;
          }
          // If stream already started sending content, do NOT fallback
          if (attempt.streamStarted) {
            attempt.partialResponse = true;
            attempts.push(attempt);
            lastError = err;
            break;
          }
          attempts.push(attempt);
          lastError = err;
          // Retry an empty 200 on the same model using its provider retry settings.
          // Reserve one attempt for a combo's next member whenever possible.
          const reserveFallback = comboPlan && eligible.some((c) => !attempted.has(c.modelId)) ? 1 : 0;
          const candidateRetries = retriesByModel.get(candidate.modelId) ?? 0;
          if (err.code === 'upstream_empty_response'
            && (!comboPlan || shouldRetry)
            && candidateRetries < provider.maxRetries
            && attemptNumber + reserveFallback < maxAttempts) {
            const delay = Math.min(provider.retryMaxMs, provider.retryBaseMs * 2 ** candidateRetries);
            retriesByModel.set(candidate.modelId, candidateRetries + 1);
            pendingRetry = candidate;
            // Release before sleeping: an empty response doesn't settle a
            // provider half-open health probe.
            if (probeToken && attemptPlan) {
              try { releaseAdaptiveProbe(attemptPlan, candidate, workload, probeToken); }
              catch (e) { errorLine(ctx.requestId, 'ADAPTIVE LEASE RELEASE ERROR', [redactString((e as Error).message)]); }
            }
            releaseCircuitAttempt(provider.id, circuitPermit);
            if (delay > 0) await waitForRetry(delay, requestAbort.signal);
            continue;
          }
          if (shouldRetry && attemptNumber < maxAttempts) continue;
        } finally {
          try {
            if (probeToken && attemptPlan) releaseAdaptiveProbe(attemptPlan, candidate, workload, probeToken);
          } catch (e) {
            errorLine(ctx.requestId, 'ADAPTIVE LEASE RELEASE ERROR', [redactString((e as Error).message)]);
          } finally {
            releaseCircuitAttempt(provider.id, circuitPermit);
          }
        }
        break;
      }

      // Build outcome
      // Every candidate may have been skipped between resolution and execution
      // (disabled provider, open circuit). That is still a failed gateway request.
      if (!completedSuccessfully && !lastError) {
        lastError = new GatewayError('upstream_unavailable', 'No upstream candidate completed successfully', { status: 503 });
      }
      if (!completedSuccessfully) lastError = abortError() ?? lastError;
      const retryAfter = (lastError?.cause as { retryAfterMs?: number } | undefined)?.retryAfterMs;
      if (typeof retryAfter === 'number' && retryAfter > 0 && !attempts.some((a) => a.streamStarted) && typeof ctx.reply.header === 'function') {
        ctx.reply.header('retry-after', String(Math.ceil(retryAfter / 1000)));
      }
      const latencyMs = Math.round(performance.now() - startMono);
      const outcome: GatewayOutcome = {
        success: !lastError,
        httpStatus: lastError ? lastError.status : 200,
        errorType: lastError?.type ?? null,
        errorMessage: lastError ? redactString(lastError.message) : null,
        errorCode: lastError?.code ?? null,
        text: lastError ? null : resultText,
        toolCalls: lastError ? null : resultToolCalls,
        finishReason: lastError ? null : resultFinishReason,
        ...(!lastError ? resultExtensions : {}),
        usage,
        ttftMs: attempts.find((a) => a.ttftMs != null)?.ttftMs ?? null,
        latencyMs,
        attempts,
        finalModelId,
        resolvedTargetKind: resolved.kind,
        resolvedTargetId: resolved.kind === 'model' ? resolved.modelId : resolved.kind === 'combo' ? resolved.comboId : null,
        gatewayCacheHit: false,
        streamEvents: null,
      };

      // Store in gateway cache if eligible
      const cacheMeta = (req as unknown as { _cacheKey?: string; _cacheConfigVersion?: number });
      // The legacy cache stores text/tool calls only. Do not cache a response
      // whose reasoning/refusal extensions would be lost on replay.
      if (!ctx.synthetic && outcome.success && cacheMeta._cacheKey && !req.canonical.stream && !hasTools(req.canonical)
        && !outcome.reasoning && !outcome.refusal && !outcome.legacyFunctionCall && !outcome.thinkingBlocks?.length && !outcome.nativeMessage) {
        const payload = this.buildCachedPayload(req, ctx, outcome);
        storeCache({
          cacheKey: cacheMeta._cacheKey,
          targetKind: resolved.kind,
          targetId: outcome.resolvedTargetId ?? '',
          configVersion: cacheMeta._cacheConfigVersion ?? 1,
          protocol: req.protocol,
          payload,
          usage: usage,
          ttlSeconds: settings.gatewayCacheDefaultTtlSeconds,
        });
      }

      await this.persistRequest(req, ctx, resolved, outcome, usage, attempts, false);
      metrics.requestsTotal.inc({ protocol: req.protocol, status: String(outcome.httpStatus) });
      metrics.requestDuration.observe(outcome.latencyMs, { protocol: req.protocol });
      if (outcome.ttftMs != null) metrics.requestTtft.observe(outcome.ttftMs, { protocol: req.protocol });
      metrics.tokensInput.inc({ protocol: req.protocol }, usage.input);
      metrics.tokensOutput.inc({ protocol: req.protocol }, usage.output);
      metrics.tokensCacheRead.inc({ protocol: req.protocol }, usage.cacheRead);
      metrics.tokensCacheWrite.inc({ protocol: req.protocol }, usage.cacheWrite);
      metrics.tokensReasoning.inc({ protocol: req.protocol }, usage.reasoning);
      return outcome;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      detachDownstream?.();
      try {
        if (ctx.key && databaseEpoch === getDatabaseEpoch()) {
          consumeUsage(ctx.key.id, quotaInput, quotaOutput);
          reconcileTpm(ctx.key.id, ctx.key.tpmLimit, tpmReserved, quotaInput + quotaOutput);
        }
      } finally {
        quotaReservation?.release();
        if (concurrencyAcquired && ctx.key) releaseConcurrent(ctx.key.id);
        metrics.activeRequests.dec();
      }
    }
  }

  /** Resolve a direct physical model into a candidate, reporting the exact
   *  reason it cannot serve the request instead of a blanket "no candidates". */
  private loadModelCandidate(
    modelId: string,
    required: RequiredCapabilities,
    requestId?: string
  ): { candidates: CandidateModel[]; rejected: RejectedMember[] } {
    const db = getDb();
    const reject = (publicModelId: string, reason: RejectionReason): RejectedMember[] => {
      if (requestId) debugHttp(requestId, 'CAPABILITY REJECT', [`modelId=${modelId}`, `reason=${reason}`]);
      return [{ publicModelId, reason }];
    };
    const m = db.select().from(schema.models).where(eq(schema.models.id, modelId)).get();
    if (!m) return { candidates: [], rejected: reject(modelId, 'model_not_found') };
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, m.providerId)).get();
    if (!p) return { candidates: [], rejected: reject(m.publicModelId, 'provider_not_found') };
    if (!p.enabled) return { candidates: [], rejected: reject(m.publicModelId, 'provider_disabled') };
    const caps = safeJson(m.capabilitiesJson);
    const candidate: CandidateModel = {
      modelId: m.id,
      publicModelId: m.publicModelId,
      upstreamModelId: m.upstreamModelId,
      providerId: m.providerId,
      enabled: m.enabled,
      providerEnabled: p.enabled,
      upstreamAvailable: m.upstreamAvailable,
      // Cooldown-aware, not the raw flag: `isOpen()` stays true until some request decays it,
      // so a raw read here refused every candidate forever and the provider was unroutable
      // until a restart.
      circuitOpen: circuitBlocks(m.providerId, p.cbCooldownSeconds) || modelThrottleBlocks(m.id),
      capabilities: caps as never,
    };
    if (!m.enabled) return { candidates: [], rejected: reject(m.publicModelId, 'model_disabled') };
    if (!m.upstreamAvailable) return { candidates: [], rejected: reject(m.publicModelId, 'upstream_unavailable') };
    if (candidate.circuitOpen) return { candidates: [], rejected: reject(m.publicModelId, 'circuit_open') };
    const missing = firstMissingCapability(caps, required);
    if (missing) return { candidates: [], rejected: reject(m.publicModelId, missing) };
    debugHttp(requestId ?? '-', 'CAPABILITY CANDIDATE', [
      `model=${m.publicModelId}`,
      `caps.tools=${(caps as { tools?: boolean }).tools}`,
      `caps.streaming=${(caps as { streaming?: boolean }).streaming}`,
      `caps.reasoning=${(caps as { reasoning?: boolean }).reasoning}`,
      `caps.image_input=${(caps as { image_input?: boolean }).image_input}`,
      `caps.structured_output=${(caps as { structured_output?: boolean }).structured_output}`,
    ]);
    return { candidates: [candidate], rejected: [] };
  }

  private loadAllModels(): CandidateModel[] {
    const db = getDb();
    const models = db.select().from(schema.models).all();
    const providers = db.select().from(schema.providers).all();
    const providerEnabled = new Map(providers.map((p) => [p.id, p.enabled]));
    for (const integration of db.select().from(schema.providerIntegrations).all()) if (integration.authMode === 'client_oauth') providerEnabled.set(integration.providerId, false);
    const providerCooldown = new Map(providers.map((p) => [p.id, p.cbCooldownSeconds]));
    // Deliberately unfiltered: every combo member must reach selectCandidates so
    // it can report WHY it was skipped. Pre-filtering here erased the model rows
    // and turned every distinct reason into "model not found".
    return models.map((m) => ({
      modelId: m.id,
      publicModelId: m.publicModelId,
      upstreamModelId: m.upstreamModelId,
      providerId: m.providerId,
      enabled: m.enabled,
      providerEnabled: providerEnabled.get(m.providerId) ?? false,
      upstreamAvailable: m.upstreamAvailable,
      // Cooldown-aware: a raw `isOpen()` here froze the whole combo on one bad minute,
      // because the flags are computed once per request while the breaker stays open
      // until some request decays it — which this filter prevented from ever happening.
      circuitOpen: circuitBlocks(m.providerId, providerCooldown.get(m.providerId) ?? 0) || modelThrottleBlocks(m.id),
      capabilities: safeJson(m.capabilitiesJson) as never,
    }));
  }

  private async runOneAttempt(
    req: GatewayRequest,
    ctx: GatewayContext,
    candidate: CandidateModel,
    cfg: ReturnType<typeof providerToUpstreamConfig>,
    onStreamStart: (started: boolean) => void,
    onFirstToken: (ttftMs: number) => void
  ): Promise<AttemptResult> {
    if (req.nativeCodex) return runCodexStreaming(req.nativeCodex, candidate.upstreamModelId, cfg, ctx, onStreamStart, onFirstToken);
    if (req.canonical.stream) {
      return this.runStreamingAttempt(req, ctx, candidate, cfg, onStreamStart, onFirstToken);
    }
    const outcome = await this.runNonStreamingAttempt(req, candidate, cfg, ctx);
    const result = outcome.result;
    const detail = { usage: outcome.usage, upstreamStatus: outcome.statusCode, upstreamRequestId: outcome.upstreamRequestId };
    if (result.legacyFunctionCall && req.endpoint !== 'chat/completions') {
      throw badGenerationError('Legacy function call requires a compatible client protocol', 'unsupported_shape', detail);
    }
    const hasAnswer = !isEmptyGeneration(outcome.usage, result) || Boolean(result.legacyFunctionCall);
    const hasReasoning = Boolean(result.reasoning || result.thinkingBlocks?.some((block) => block.thinking.length > 0));
    const canDeliverReasoning = (cfg.type === 'openai' && req.endpoint === 'chat/completions')
      || (cfg.type === 'anthropic' && req.endpoint === 'messages');
    if (!hasAnswer) {
      if (hasReasoning && (!canDeliverReasoning || !isLengthFinish(result.finishReason))) {
        errorLine(ctx.requestId, 'GENERATION ERROR', [`stage=incomplete_generation`, `upstreamStatus=${outcome.statusCode}`, `upstreamRequestId=${diagnosticLabel(outcome.upstreamRequestId)}`, `providerProtocol=${cfg.type}`, `clientEndpoint=${req.endpoint}`, `finishReason=${diagnosticLabel(result.finishReason)}`, `outputTokens=${outcome.usage.output}`, 'reasoning=true', 'answer=false']);
        throw badGenerationError('Upstream returned reasoning without a deliverable answer', 'incomplete_generation', detail);
      }
      if (!hasReasoning) {
        errorLine(ctx.requestId, 'GENERATION ERROR', ['stage=no_generation_at_eof', `upstreamStatus=${outcome.statusCode}`, `upstreamRequestId=${diagnosticLabel(outcome.upstreamRequestId)}`, `providerProtocol=${cfg.type}`, `clientEndpoint=${req.endpoint}`, `finishReason=${diagnosticLabel(result.finishReason)}`, `outputTokens=${outcome.usage.output}`]);
        throw emptyGenerationError(candidate, outcome.usage, detail);
      }
    }
    return outcome;
  }

  private async runNonStreamingAttempt(
    req: GatewayRequest,
    candidate: CandidateModel,
    cfg: ReturnType<typeof providerToUpstreamConfig>,
    ctx: GatewayContext
  ): Promise<AttemptResult> {
    const upstreamModel = candidate.upstreamModelId;
    let call: UpstreamCall;
    if (cfg.type === 'openai') {
      const payload = canonicalToOpenAIRequest(req.canonical, upstreamModel);
      logUpstreamRequest(ctx.requestId, cfg, upstreamUrl(cfg, '/v1/chat/completions'), payload, req.canonical.stream);
      call = await callUpstreamNonStreaming(cfg, upstreamUrl(cfg, '/v1/chat/completions'), payload, ctx.requestId);
    } else {
      const payload = cfg.nativeClaude && req.nativeMessages ? { ...req.nativeMessages, model: upstreamModel, max_tokens: req.canonical.maxOutputTokens ?? 1024, stream: false } : canonicalToAnthropicRequest(req.canonical, upstreamModel);
      logUpstreamRequest(ctx.requestId, cfg, upstreamUrl(cfg, '/v1/messages'), payload, req.canonical.stream);
      call = await callUpstreamNonStreaming(cfg, upstreamUrl(cfg, '/v1/messages'), payload, ctx.requestId);
    }
    if (!call.ok) {
      const error = upstreamHttpError(call.status, redactString(call.text.slice(0, 500)), { status: call.status, requestId: call.upstreamRequestId, retryAfterMs: retryAfterMs(call.headers['retry-after']) });
      throw new GatewayError(error.type, error.message, { status: error.status, code: error.code, safe: error.safe, cause: {
        ...error.cause as Record<string, unknown>, upstreamStatus: call.status, upstreamRequestId: call.upstreamRequestId, contentType: call.headers['content-type'] ?? null,
      } });
    }
    const detail = { upstreamStatus: call.status, upstreamRequestId: call.upstreamRequestId, contentType: call.headers['content-type'] ?? null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.text);
    } catch {
      throw badGenerationError(`Upstream returned invalid JSON for "${bareModelName(candidate.publicModelId)}"`, 'invalid_json', detail);
    }
    // A 200 carrying the wrong shape used to explode into a raw
    // "Cannot read properties of undefined (reading '0')" that reached the client
    // verbatim. Name the model and the missing field instead.
    const expectedField = cfg.type === 'openai' ? 'choices' : 'content';
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>)[expectedField])) {
      const usage = parsed && typeof parsed === 'object' ? (cfg.type === 'openai'
        ? openAIResponseToCanonical(parsed as never, req.canonical.model).usage
        : anthropicResponseToCanonical(parsed as never, req.canonical.model).usage) : undefined;
      throw badGenerationError(
        `Upstream response for "${bareModelName(candidate.publicModelId)}" has no "${expectedField}" array`,
        'unsupported_shape', { ...detail, ...(usage ? { usage } : {}) }
      );
    }
    let result: GenerationResult;
    let usage: UsageSummary;
    if (cfg.type === 'openai') {
      const conv = openAIResponseToCanonical(parsed as never, req.canonical.model);
      result = { text: conv.text, toolCalls: conv.toolCalls, finishReason: conv.finishReason, reasoning: conv.reasoning, refusal: conv.refusal, legacyFunctionCall: conv.legacyFunctionCall };
      usage = conv.usage;
    } else {
      const conv = anthropicResponseToCanonical(parsed as never, req.canonical.model);
      result = { text: conv.text, toolCalls: conv.toolCalls, finishReason: conv.finishReason, thinkingBlocks: conv.thinkingBlocks, ...(cfg.nativeClaude && req.nativeMessages ? { nativeMessage: parsed as Record<string, unknown> } : {}) };
      usage = conv.usage;
    }
    return { statusCode: call.status, ttftMs: call.ttftMs, upstreamRequestId: call.upstreamRequestId, usage, result };
  }

  private async runStreamingAttempt(
    req: GatewayRequest,
    ctx: GatewayContext,
    candidate: CandidateModel,
    cfg: ReturnType<typeof providerToUpstreamConfig>,
    onStreamStart: (started: boolean) => void,
    onFirstToken: (ttftMs: number) => void
  ): Promise<AttemptResult> {
    const upstreamModel = candidate.upstreamModelId;
    const encoder = req.protocol === 'openai' ? openaiStreamEncoder : anthropicStreamEncoder;
    const sameFamily = cfg.type === req.protocol && req.endpoint !== 'responses';

    // Hard streaming invariant: the client SSE head is NOT written until the
    // upstream confirms by delivering its first chunk (or completes). Before
    // that first chunk, a pre-stream failure may fall back to the next model.
    // Once content hits the client, fallback is forbidden (see docs/04).
    const pipe = ctx.reply.raw;
    let headWritten = false;
    const writeHead = () => {
      if (headWritten) return;
      pipe.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': ctx.requestId,
      });
      headWritten = true;
    };

    let streamStarted = false;
    let streamStartTs = Date.now();
    let streamStartMono = performance.now();
    let textBuf = '';
    let refusalBuf = '';
    // Arguments arrive in fragments. Keep one logical call per protocol index;
    // the original deltas are forwarded immediately to the client.
    const toolBuf = new Map<number, { id: string; name: string; arguments: string; input?: unknown }>();
    const legacyFunctionCall = { name: '', arguments: '' };
    let finishReason: string | null = null;
    const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
    let meaningfulTtftMs: number | null = null;
    // Hold only the initial metadata events (role, message_start, usage, etc.).
    // Committing HTTP 200 for metadata alone makes an empty 200 un-retryable.
    const initialEvents: string[] = [];
    let initialBytes = 0;
    let initialEventCount = 0;
    let openaiRoleQueued = false;

    // docs/13 §15–§16: stream counters + client disconnect tracking
    let chunkCount = 0;
    let bytesReceived = 0;
    let firstChunkTime: number | null = null;
    let lastChunkTime: number | null = null;
    let textEvents = 0;
    let reasoningEvents = 0;
    let toolEvents = 0;
    let metadataEvents = 0;
    let unknownEvents = 0;
    let firstAnswerMs: number | null = null;
    let terminalEvent: string | null = null;
    let responseMeta: Awaited<ReturnType<typeof callUpstreamStreaming>> | undefined;
    let clientDisconnected = false;
    const downstreamAbort = new AbortController();
    let detachDownstreamClose: (() => void) | null = null;
    if (typeof (pipe as { on?: unknown }).on === 'function' && typeof (pipe as { off?: unknown }).off === 'function') {
      detachDownstreamClose = watchDownstreamDisconnect(pipe, () => {
        // A closed downstream socket must stop upstream work too. Otherwise the
        // gateway keeps draining billable tokens after nobody can receive them.
        clientDisconnected = true;
        downstreamAbort.abort();
        debugStream(ctx.requestId, 'CLIENT DISCONNECT', [
          `afterMs=${Date.now() - streamStartTs}`,
          `streaming=${streamStarted}`,
          `chunksSoFar=${chunkCount}`,
        ]);
      });
    }
    // Guard: the admin test-stream endpoint passes a minimal `fakeRaw` that has
    // writeHead/write/end but no `.on` — skip disconnect tracking in that case.

    const chunkHandler = (chunk: { data: string; event?: string }, isFirst: boolean): boolean => {
      if (cfg.requestSignal?.aborted) throw cfg.requestSignal.reason;
      chunkCount++;
      bytesReceived += Buffer.byteLength(chunk.data);
      lastChunkTime = Date.now();
      if (isFirst) firstChunkTime = Date.now() - streamStartTs;
      let hasAnswer = false;
      let hasReasoning = false;
      let hasTool = false;
      let recognizedShape: boolean;
      let skipPrelude = false;
      let obj: ReturnType<typeof JSON.parse>;
      try {
        obj = JSON.parse(chunk.data);
      } catch {
        throw new GatewayError('upstream_error', 'Upstream returned invalid streaming JSON', { status: 502, code: 'upstream_bad_response' });
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new GatewayError('upstream_error', 'Upstream returned invalid streaming event', { status: 502, code: 'upstream_bad_response' });
      }
      if (obj.type === 'error' || obj.error || chunk.event === 'error') {
        const message = typeof obj.error?.message === 'string' ? redactString(obj.error.message.slice(0, 300)) : 'Upstream returned a streaming error';
        throw new GatewayError('upstream_error', message, { status: 502, code: 'upstream_bad_response' });
      }
      try {
        if (cfg.type === 'openai') {
          recognizedShape = Array.isArray(obj.choices) || Boolean(obj.usage && typeof obj.usage === 'object');
          const choice = obj.choices?.[0];
          if (chunk.event === 'json' && (!Array.isArray(obj.choices) || (obj.choices.length > 0 && (!choice?.message || choice.delta)))) {
            throw badGenerationError('Upstream JSON is not a complete chat completion', 'unsupported_shape');
          }
          // Some compatible relays send a single complete chat message in an
          // SSE frame. Convert it once; never append a cumulative snapshot to
          // already delivered deltas.
          if (choice?.message && !choice.delta) {
            if (streamStarted || !sameFamily || !nonemptyString(choice.finish_reason)) {
              throw badGenerationError('Unsupported complete-message streaming snapshot', 'unsupported_shape');
            }
            const { message, ...rest } = choice;
            const delta = { ...message };
            if (Array.isArray(message.tool_calls)) {
              delta.tool_calls = message.tool_calls.map((call: Record<string, unknown>, index: number) => ({ ...call, index }));
            }
            obj = { ...obj, object: 'chat.completion.chunk', choices: [{ ...rest, delta }] };
          }
          const normalizedChoice = obj.choices?.[0];
          const delta = normalizedChoice?.delta;
          const text = extractAssistantText(delta?.content);
          if (Array.isArray(delta?.content)) delta.content = text;
          if (text) {
            textBuf += text;
            hasAnswer = true;
          }
          if (nonemptyString(delta?.refusal)) {
            refusalBuf += delta.refusal;
            hasAnswer = true;
          }
          if (nonemptyString(delta?.reasoning_content)) {
            if (!sameFamily) throw badGenerationError('Reasoning stream requires a compatible client protocol', 'unsupported_shape');
            hasReasoning = true;
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const [position, tc] of delta.tool_calls.entries()) {
              if (!tc || typeof tc !== 'object') throw badGenerationError('Invalid streaming tool call', 'unsupported_shape');
              const index = Number.isSafeInteger(tc.index) && tc.index >= 0 ? tc.index : position;
              const rawArguments = tc.function?.arguments;
              if (!nonemptyString(tc.id) && !nonemptyString(tc.function?.name) && !nonemptyString(rawArguments)
                && !(rawArguments && typeof rawArguments === 'object')) continue;
              const tool = toolBuf.get(index) ?? { id: '', name: '', arguments: '', input: undefined as unknown };
              if (nonemptyString(tc.id)) tool.id = tc.id;
              if (nonemptyString(tc.function?.name)) tool.name += tc.function.name;
              if (typeof rawArguments === 'string') tool.arguments += rawArguments;
              else if (rawArguments && typeof rawArguments === 'object') tool.input = rawArguments;
              toolBuf.set(index, tool);
              if (tool.id && tool.name) hasTool = true;
            }
          }
          if (delta?.function_call) {
            if (!sameFamily) throw badGenerationError('Legacy function call requires a compatible client protocol', 'unsupported_shape');
            if (nonemptyString(delta.function_call.name)) legacyFunctionCall.name += delta.function_call.name;
            if (typeof delta.function_call.arguments === 'string') legacyFunctionCall.arguments += delta.function_call.arguments;
            if (legacyFunctionCall.name) hasTool = true;
          }
          if (nonemptyString(normalizedChoice?.finish_reason)) finishReason = normalizedChoice.finish_reason;
          if (obj.usage) {
            usage.input = tokenCount(obj.usage.prompt_tokens, usage.input);
            usage.output = tokenCount(obj.usage.completion_tokens, usage.output);
            usage.cacheRead = tokenCount(obj.usage.prompt_tokens_details?.cached_tokens, usage.cacheRead);
            usage.reasoning = tokenCount(obj.usage.completion_tokens_details?.reasoning_tokens, usage.reasoning);
            usage.total = tokenCount(obj.usage.total_tokens, usage.total);
          }
          // Empty delta frames and duplicate role announcements are no-ops.
          // Retain usage, finish, tool fragments and unknown extension fields.
          if (!hasAnswer && !hasReasoning && !hasTool && normalizedChoice && !obj.usage && !normalizedChoice.finish_reason
            && obj.choices.length === 1 && delta && typeof delta === 'object' && !Array.isArray(delta)
            && Object.keys(delta).every((key) => key === 'role' || (['content', 'refusal', 'reasoning_content'].includes(key) && (delta[key] === null || delta[key] === '')))) {
            if (delta.role === 'assistant' && !openaiRoleQueued) openaiRoleQueued = true;
            else skipPrelude = true;
          }
        } else {
          recognizedShape = ['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'ping'].includes(obj.type);
          const block = obj.type === 'content_block_start' ? obj.content_block : undefined;
          const delta = obj.type === 'content_block_delta' ? obj.delta : undefined;
          const text = block?.type === 'text' ? block.text : delta?.type === 'text_delta' ? delta.text : undefined;
          if (nonemptyString(text)) {
            textBuf += text;
            hasAnswer = true;
          }
          const thinking = block?.type === 'thinking' ? block.thinking : delta?.type === 'thinking_delta' ? delta.thinking : undefined;
          if (nonemptyString(thinking)) {
            if (!sameFamily) throw badGenerationError('Thinking stream requires a compatible client protocol', 'unsupported_shape');
            hasReasoning = true;
          }
          if (block?.type === 'tool_use' && nonemptyString(block.id) && nonemptyString(block.name)) {
            const index = Number.isSafeInteger(obj.index) && obj.index >= 0 ? obj.index : toolBuf.size;
            toolBuf.set(index, { id: block.id, name: block.name, arguments: '', input: block.input ?? {} });
            hasTool = true;
          }
          if (delta?.type === 'input_json_delta' && nonemptyString(delta.partial_json)) {
            const tool = toolBuf.get(obj.index);
            if (tool) { tool.arguments += delta.partial_json; hasTool = true; }
          }
          if (obj.type === 'message_delta' && nonemptyString(obj.delta?.stop_reason)) finishReason = obj.delta.stop_reason;
          if (obj.type === 'message_start' && obj.message?.usage) {
            usage.input = tokenCount(obj.message.usage.input_tokens);
            usage.output = tokenCount(obj.message.usage.output_tokens, usage.output);
            usage.cacheRead = tokenCount(obj.message.usage.cache_read_input_tokens);
            usage.cacheWrite = tokenCount(obj.message.usage.cache_creation_input_tokens);
          }
          if (obj.type === 'message_delta' && obj.usage) {
            usage.output = tokenCount(obj.usage.output_tokens, usage.output);
          }
        }
      } catch (e) {
        if (e instanceof GatewayError) throw e;
        throw badGenerationError('Upstream returned malformed streaming content', 'unsupported_shape');
      }

      if (hasAnswer) textEvents++;
      if (hasReasoning) reasoningEvents++;
      if (hasTool) toolEvents++;
      const hasOutput = hasAnswer || hasTool || hasReasoning;
      if (!hasOutput) metadataEvents++;
      if (!recognizedShape) unknownEvents++;
      if ((hasAnswer || hasTool) && firstAnswerMs === null) firstAnswerMs = Math.round(performance.now() - streamStartMono);
      if (chunkCount <= 3) debugStream(ctx.requestId, `STREAM FIRST CHUNK ${chunkCount}`, [
        `bytes=${Buffer.byteLength(chunk.data)}`, `text=${hasAnswer}`, `tool=${hasTool}`, `reasoning=${hasReasoning}`,
      ]);
      // Anthropic's authoritative terminal is emitted only after the attempt
      // validates completion; do not report a clean terminal for a partial stream.
      const encoded = encoder(JSON.stringify(obj), cfg.type === 'anthropic' && sameFamily ? obj.type ?? chunk.event : chunk.event);
      if (cfg.type === 'anthropic' && obj.type === 'message_stop') {
        terminalEvent = encoded;
        return false;
      }
      if (!streamStarted) {
        if (!hasOutput && encoded) {
          // Repeated pings carry no semantic state and must not exhaust the
          // prelude budget. Retain required role/start and usage frames.
          if (obj.type === 'ping' || skipPrelude) return false;
          initialEvents.push(encoded);
          initialBytes += Buffer.byteLength(encoded);
          initialEventCount++;
        }
        if (!hasOutput) {
          if (initialBytes > 65536 || initialEvents.length > 128) {
            throw badGenerationError('Upstream streaming metadata exceeded the prelude limit', 'prelude_limit');
          }
          return false;
        }
        // Deliverable reasoning, text and tool output commit the stream. Metadata-only streams
        // can still retry or fall back with an ordinary HTTP error response.
        meaningfulTtftMs = Math.round(performance.now() - streamStartMono);
        onFirstToken(meaningfulTtftMs);
        writeHead();
        // Commit markers move only after pre-commit bookkeeping and writeHead
        // succeed. A failure before this point remains safe to fallback.
        streamStarted = true;
        onStreamStart(true);
        for (const event of initialEvents) pipe.write(event);
        initialEvents.length = 0;
        if (encoded) pipe.write(encoded);
        return true;
      }
      if (encoded) pipe.write(encoded);
      return hasOutput;
    };

    try {
      const url = cfg.type === 'openai' ? upstreamUrl(cfg, '/v1/chat/completions') : upstreamUrl(cfg, '/v1/messages');
      const payload = cfg.type === 'openai' ? canonicalToOpenAIRequest(req.canonical, upstreamModel) : cfg.nativeClaude && req.nativeMessages ? { ...req.nativeMessages, model: upstreamModel, max_tokens: req.canonical.maxOutputTokens ?? 1024, stream: true } : canonicalToAnthropicRequest(req.canonical, upstreamModel);
      logUpstreamRequest(ctx.requestId, cfg, url, payload, true);
      debugStream(ctx.requestId, 'STREAM START', [`upstreamConnected=true`]);
      streamStartTs = Date.now();
      streamStartMono = performance.now();
      const meta = responseMeta = await callUpstreamStreaming(cfg, url, payload, chunkHandler, ctx.requestId, streamStartTs, downstreamAbort.signal);
      const detail = { upstreamStatus: meta.upstreamStatus, upstreamRequestId: meta.upstreamRequestId, contentType: meta.contentType, terminalSeen: meta.terminalSeen };
      if (!streamStarted) {
        if (unknownEvents > 0) throw badGenerationError('Upstream stream contained unrecognized output events', 'unsupported_shape', detail);
        throw emptyGenerationError(candidate, usage, detail);
      }
      // Native Anthropic requires the actual message_stop. A stop_reason in
      // message_delta is not a terminal frame and cannot certify completion.
      if (!meta.terminalSeen && (cfg.nativeClaude || !finishReason)) {
        throw badGenerationError('Upstream stream ended before a completion marker', 'truncated_stream', detail);
      }
      if (reasoningEvents > 0 && textEvents === 0 && toolEvents === 0 && !isLengthFinish(finishReason)) {
        throw badGenerationError('Upstream returned reasoning without a final answer', 'incomplete_generation', detail);
      }
      if (cfg.requestSignal?.aborted) throw cfg.requestSignal.reason;
      if (req.protocol === 'anthropic' && cfg.type === 'anthropic') {
        pipe.write(terminalEvent ?? anthropicStreamEncoder('{"type":"message_stop"}', 'message_stop'));
      } else {
        if (terminalEvent) pipe.write(terminalEvent);
        pipe.write('data: [DONE]\n\n');
      }
      pipe.end();
      debugStream(ctx.requestId, 'STREAM END', [
        `chunks=${chunkCount}`,
        `bytes=${bytesReceived}`,
        `firstChunkMs=${firstChunkTime ?? 'null'}`,
        `lastChunkMs=${lastChunkTime ? lastChunkTime - streamStartTs : 'null'}`,
        `durationMs=${Date.now() - streamStartTs}`,
        `finishedNormally=true`,
        `clientDisconnected=${clientDisconnected}`,
      ]);
      if (!usage.total) usage.total = usage.input + usage.output;
      return {
        statusCode: meta.upstreamStatus,
        ttftMs: meaningfulTtftMs ?? meta.ttftMs,
        upstreamRequestId: meta.upstreamRequestId,
        usage,
        result: { text: textBuf || refusalBuf, ...(refusalBuf ? { refusal: refusalBuf } : {}), toolCalls: Array.from(toolBuf.values()).filter((tool) => tool.id && tool.name).map((tool) => ({
          id: tool.id, name: tool.name, input: tool.arguments ? safeJsonParse(tool.arguments) : tool.input ?? {},
        })), finishReason, ...(legacyFunctionCall.name ? { legacyFunctionCall } : {}) },
      };
    } catch (e) {
      // Once committed, end the partial stream without a clean terminal. The
      // outer attempt loop must not try another model on this connection.
      if (streamStarted && !pipe.writableEnded) pipe.end();
      const gatewayError = e instanceof GatewayError ? e : new GatewayError('upstream_error', (e as Error).message, { cause: e });
      const originalCause = gatewayError.cause;
      const causeRecord = originalCause && typeof originalCause === 'object'
        ? originalCause as Record<string, unknown>
        : {};
      // Metadata-only Anthropic/OpenAI events can already report billable input/cache usage.
      // Preserve it for every pre-content failure, including first-token and total timeouts.
      const cause = {
        ...causeRecord,
        upstreamStatus: causeRecord.upstreamStatus ?? responseMeta?.upstreamStatus ?? null,
        upstreamRequestId: causeRecord.upstreamRequestId ?? responseMeta?.upstreamRequestId ?? null,
        contentType: causeRecord.contentType ?? responseMeta?.contentType ?? null,
        terminalSeen: causeRecord.terminalSeen ?? responseMeta?.terminalSeen ?? false,
        message: typeof causeRecord.message === 'string'
          ? causeRecord.message
          : originalCause instanceof Error ? originalCause.message : undefined,
        status: typeof causeRecord.status === 'number' ? causeRecord.status : undefined,
        bodyExcerpt: typeof causeRecord.bodyExcerpt === 'string' ? causeRecord.bodyExcerpt : undefined,
        originalCause,
        usage,
      };
      errorLine(ctx.requestId, streamStarted ? 'STREAM ERROR' : 'STREAM ERROR (before first chunk)', [
        `stage=${diagnosticLabel(causeRecord.stage ?? gatewayError.code)}`,
        `providerProtocol=${cfg.type}`, `clientEndpoint=${req.endpoint}`,
        `upstreamStatus=${cause.upstreamStatus ?? 'unknown'}`, `upstreamRequestId=${diagnosticLabel(cause.upstreamRequestId)}`,
        `contentType=${diagnosticLabel(cause.contentType)}`, `terminalSeen=${cause.terminalSeen}`,
        `finishReason=${diagnosticLabel(finishReason)}`, `committed=${streamStarted}`,
        `chunksBeforeError=${chunkCount}`, `bytesBeforeError=${bytesReceived}`,
        `preludeBytes=${initialBytes}`, `preludeEvents=${initialEventCount}`,
        `textEvents=${textEvents}`, `reasoningEvents=${reasoningEvents}`, `toolEvents=${toolEvents}`, `metadataEvents=${metadataEvents}`, `unknownEvents=${unknownEvents}`,
        `firstGeneratedMs=${meaningfulTtftMs ?? 'null'}`, `firstAnswerMs=${firstAnswerMs ?? 'null'}`,
        `inputTokens=${usage.input}`, `outputTokens=${usage.output}`, `reasoningTokens=${usage.reasoning}`,
        `clientDisconnected=${clientDisconnected}`,
      ]);
      throw new GatewayError(gatewayError.type, gatewayError.message, {
        status: gatewayError.status,
        code: gatewayError.code,
        safe: gatewayError.safe, cause,
      });
    } finally {
      detachDownstreamClose?.();
    }
  }

  private getTargetCacheOverride(resolved: { kind: 'model' | 'combo' } & { modelId?: string; comboId?: string }): boolean | null {
    const db = getDb();
    if (resolved.kind === 'model' && 'modelId' in resolved && resolved.modelId) {
      const m = db.select().from(schema.models).where(eq(schema.models.id, resolved.modelId)).get();
      return m?.cacheOverrideEnabled ?? null;
    }
    if (resolved.kind === 'combo' && 'comboId' in resolved && resolved.comboId) {
      const c = db.select().from(schema.combos).where(eq(schema.combos.id, resolved.comboId)).get();
      return c?.cacheOverrideEnabled ?? null;
    }
    return null;
  }

  private getTargetConfigVersion(resolved: { kind: 'model' | 'combo' } & { comboId?: string }): number {
    if (resolved.kind === 'combo' && 'comboId' in resolved && resolved.comboId) {
      const db = getDb();
      const c = db.select().from(schema.combos).where(eq(schema.combos.id, resolved.comboId)).get();
      return c?.configVersion ?? 1;
    }
    return 1;
  }

  private resolvedId(resolved: { kind: 'model' | 'combo' } & { modelId?: string; comboId?: string }): string {
    if (resolved.kind === 'model' && resolved.modelId) return resolved.modelId;
    if (resolved.kind === 'combo' && resolved.comboId) return resolved.comboId;
    return '';
  }

  private buildCachedPayload(req: GatewayRequest, ctx: GatewayContext, outcome: GatewayOutcome): unknown {
    // Encode canonical outcome into the originating protocol's JSON response shape.
    if (req.protocol === 'openai') {
      return {
        id: `chatcmpl-${ctx.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.canonical.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: outcome.text,
              ...(outcome.toolCalls && outcome.toolCalls.length ? { tool_calls: outcome.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) } : {}),
            },
            finish_reason: outcome.finishReason,
          },
        ],
        usage: {
          prompt_tokens: outcome.usage.input,
          completion_tokens: outcome.usage.output,
          total_tokens: outcome.usage.total,
        },
      };
    }
    return {
      id: `msg_${ctx.requestId}`,
      type: 'message',
      role: 'assistant',
      model: req.canonical.model,
      content: [
        ...(outcome.text ? [{ type: 'text', text: outcome.text }] : []),
        ...(outcome.toolCalls ?? []).map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })),
      ],
      stop_reason: outcome.finishReason,
      usage: {
        input_tokens: outcome.usage.input,
        output_tokens: outcome.usage.output,
        cache_read_input_tokens: outcome.usage.cacheRead,
        cache_creation_input_tokens: outcome.usage.cacheWrite,
      },
    };
  }

  private cachedToOutcome(payload: unknown, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total?: number } | null, ctx: GatewayContext, resolved: { kind: string } & { modelId?: string }, start: number): GatewayOutcome {
    const p = payload as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string | null }>; content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason?: string | null };
    let text = '';
    let toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let finishReason: string | null = null;
    if (p.choices) {
      const c = p.choices[0];
      text = c?.message?.content ?? '';
      toolCalls = (c?.message?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, input: safeJsonParse(tc.function.arguments) }));
      finishReason = c?.finish_reason ?? null;
    } else if (p.content) {
      text = p.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      toolCalls = p.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} }));
      finishReason = p.stop_reason ?? null;
    }
    const u: UsageSummary = usage ? { ...usage, total: usage.total ?? usage.input + usage.output } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
    return {
      success: true,
      httpStatus: 200,
      errorType: null,
      errorMessage: null,
      errorCode: null,
      text,
      toolCalls,
      finishReason,
      usage: u,
      ttftMs: 0,
      latencyMs: Date.now() - start,
      attempts: [],
      finalModelId: resolved.kind === 'model' && 'modelId' in resolved ? (resolved as { modelId?: string }).modelId ?? null : null,
      resolvedTargetKind: resolved.kind,
      resolvedTargetId: null,
      gatewayCacheHit: true,
      streamEvents: null,
    };
  }

  private async persistRequest(
    req: GatewayRequest,
    ctx: GatewayContext,
    resolved: { kind: 'model' | 'combo' | 'alias'; modelId?: string; comboId?: string },
    outcome: GatewayOutcome,
    usage: UsageSummary,
    attempts: AttemptOutcome[],
    cacheHit: boolean
  ): Promise<void> {
    const db = getDb();
    const settings = getSettings();
    const requestId = ctx.requestId;
    const now = new Date().toISOString();
    let requestPayload: string | null = null;
    let responsePayload: string | null = null;
    if (!req.nativeCodex && (settings.contentLogMode === 'prompt' || settings.contentLogMode === 'prompt_and_response')) {
      requestPayload = JSON.stringify(redactValue(req.canonical));
    }
    if (!req.nativeCodex && settings.contentLogMode === 'prompt_and_response') {
      responsePayload = JSON.stringify(redactValue({ text: outcome.text, toolCalls: outcome.toolCalls, finishReason: outcome.finishReason }));
    }
    const persistedAttempts = attempts.map((a) => ({
      id: uuid(),
      requestId,
      attemptNumber: a.attemptNumber,
      providerId: a.providerId,
      modelId: a.modelId,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      statusCode: a.statusCode,
      success: a.success,
      latencyMs: a.latencyMs,
      ttftMs: a.ttftMs,
      inputTokens: a.usage.input,
      outputTokens: a.usage.output,
      cacheReadTokens: a.usage.cacheRead,
      cacheWriteTokens: a.usage.cacheWrite,
      reasoningTokens: a.usage.reasoning,
      streamStarted: a.streamStarted ? 1 : 0,
      partialResponse: a.partialResponse ? 1 : 0,
      selectionReason: a.selectionReason,
      failureReason: a.failureReason,
      errorMessage: a.sanitizedError ? redactString(a.sanitizedError) : null,
      upstreamRequestId: a.upstreamRequestId,
    }));
    const tx = getRawDb().transaction(() => {
    // Assign a strictly increasing completion timestamp inside the same
    // transaction as the row insert. IDs are generated at request arrival and
    // may be supplied by clients, so they are not a safe live-event tie-breaker.
    const latestRequest = db.select({ createdAt: schema.requests.createdAt })
      .from(schema.requests)
      .orderBy(desc(schema.requests.createdAt))
      .limit(1)
      .get();
    const completedAt = nextRequestCompletionTimestamp(new Date(), latestRequest?.createdAt);
    db.insert(schema.requests).values({
      id: requestId,
      createdAt: completedAt,
      completedAt,
      apiKeyId: ctx.key?.id ?? null,
      keyPrefixSnapshot: ctx.key?.keyPrefix ?? null,
      clientIp: ctx.clientIp,
      protocol: ctx.protocol as 'openai' | 'anthropic',
      endpoint: req.endpoint,
      requestedModel: req.canonical.model,
      resolvedTargetKind: outcome.resolvedTargetKind,
      resolvedTargetId: outcome.resolvedTargetId,
      finalModelId: outcome.finalModelId,
      streaming: req.canonical.stream,
      httpStatus: outcome.httpStatus,
      success: outcome.success ? 1 : 0,
      totalLatencyMs: outcome.latencyMs,
      ttftMs: outcome.ttftMs,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      reasoningTokens: usage.reasoning,
      totalTokens: usage.total,
      attemptsCount: attempts.length,
      errorType: outcome.errorType,
      errorMessage: outcome.errorMessage ? redactString(outcome.errorMessage) : null,
      requestPayloadJson: requestPayload,
      responsePayloadJson: responsePayload,
      gatewayCacheHit: cacheHit ? true : false,
      partialStream: attempts.some((attempt) => attempt.partialResponse),
    } as never).run();

    for (const attempt of persistedAttempts) db.insert(schema.requestAttempts).values(attempt as never).run();
    upsertDailyAggregates(getRawDb(), {
      day: now.slice(0, 10), modelId: outcome.finalModelId, apiKeyId: ctx.key?.id ?? null,
      success: outcome.success, inputTokens: usage.input, outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, reasoningTokens: usage.reasoning,
      cacheHit, attemptsCount: attempts.length, latencyMs: outcome.latencyMs, ttftMs: outcome.ttftMs,
    }, attempts.map((a) => ({
      day: a.startedAt.slice(0, 10), providerId: a.providerId, success: a.success,
      inputTokens: a.usage.input, outputTokens: a.usage.output, cacheReadTokens: a.usage.cacheRead,
      cacheWriteTokens: a.usage.cacheWrite, reasoningTokens: a.usage.reasoning, latencyMs: a.latencyMs,
    })));
    });
    tx();

    emitRequestLogged(requestId);
  }
}

/** Explicit model-scoped refusals must not disable other models of this provider. */
export function isModelScopedFailure(err: GatewayError): boolean {
  const cause = err.cause as { bodyExcerpt?: unknown; status?: unknown } | undefined;
  const detail = typeof cause?.bodyExcerpt === 'string' ? cause.bodyExcerpt : '';
  return /\bmodel[_-](?:not[_-]found|not[_-]available|unavailable|overloaded|rate[_-]limit(?:ed|_exceeded)?|disabled|capacity)\b/i.test(detail)
    || /\b(?:this|requested|specific) model (?:is |was )?(?:not available|unavailable|overloaded|rate limited|disabled|not found)\b/i.test(detail);
}

export function isUpstreamHealthFailure(err: GatewayError): boolean {
  if (isModelScopedFailure(err)) return false;
  const reason = classifyFailure(err);
  if (['connection_error', 'connect_timeout', 'stream_idle_timeout', 'total_timeout'].includes(reason)) return true;
  if (reason !== 'http_status') return false;
  const status = (err.cause as { status?: unknown } | undefined)?.status ?? err.status;
  return typeof status === 'number' && status >= 500 && status < 600;
}

/** Distinguish exhausted upstream quota from transient throttling using status and message. */
export function isQuotaFailure(err: GatewayError): boolean {
  const cause = err.cause as { status?: unknown } | undefined;
  const upstreamStatus = typeof cause?.status === 'number' ? cause.status : err.status;
  if (upstreamStatus !== 429 && upstreamStatus !== 403) return false;
  const body = (err.cause as { bodyExcerpt?: string } | undefined)?.bodyExcerpt ?? '';
  return /usage[_ -]?limit|quota|out of credits|insufficient[_ -]?(credit|balance)|exceeded your current quota|billing/i.test(`${err.message} ${body}`);
}

/** Whether a failed attempt should advance to the next configured candidate. */
export function shouldRetryAttempt(comboPlan: ComboPlan | null, err: GatewayError): boolean {
  if (err.code === 'client_disconnected' || err.code === 'combo_overall_timeout') return false;
  if (isQuotaFailure(err)) return true;
  if (err.code === 'upstream_empty_response' || err.code === 'upstream_bad_response') return comboPlan?.trigger.on5xx ?? false;
  if (err.code === 'combo_slow_response_timeout') return comboPlan?.slowResponseFallbackEnabled ?? false;
  const causeStatus = (err.cause as { status?: unknown } | undefined)?.status;
  const status = typeof causeStatus === 'number' ? causeStatus : err.status;
  return comboPlan ? shouldFallback(comboPlan, { type: classifyFailure(err), status }) : false;
}

export function classifyFailure(err: GatewayError): string {
  if (err.code === 'client_disconnected') return 'client_disconnected';
  if (err.code === 'combo_overall_timeout') return 'overall_timeout';
  if (err.code === 'upstream_bad_response') return 'bad_response';
  if (err.code === 'upstream_empty_response') return 'empty_response';
  if (err.code === 'combo_slow_response_timeout') return 'slow_response_timeout';
  if (err.code === 'upstream_connect_timeout') return 'connect_timeout';
  if (err.code === 'upstream_first_token_timeout') return 'first_token_timeout';
  if (err.code === 'upstream_stream_idle_timeout') return 'stream_idle_timeout';
  if (err.code === 'upstream_total_timeout') return 'total_timeout';
  // Preserve quota exhaustion as a distinct upstream failure category.
  if (isQuotaFailure(err)) return 'quota';
  switch (err.type) {
    case 'timeout_error':
      if (err.message.toLowerCase().includes('first token')) return 'first_token_timeout';
      if (err.message.toLowerCase().includes('connect')) return 'connect_timeout';
      return 'total_timeout';
    case 'upstream_unavailable':
      return 'connection_error';
    case 'upstream_rate_limit':
      return 'http_status';
    case 'upstream_error': {
      const upstreamStatus = (err.cause as { status?: unknown } | undefined)?.status;
      return typeof upstreamStatus === 'number' && (upstreamStatus === 408 || (upstreamStatus >= 500 && upstreamStatus < 600))
        ? 'http_status'
        : 'unknown';
    }
    default:
      return 'unknown';
  }
}

function overallDeadlineError(): GatewayError {
  return new GatewayError('timeout_error', 'Combo overall request deadline exceeded', { status: 504, code: 'combo_overall_timeout' });
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Only semantic output establishes a generation. Usage alone is not a response,
 * and a number of OpenAI-compatible services omit usage even for valid generations. */
function isEmptyGeneration(
  _usage: UsageSummary,
  result: { text: string; toolCalls: Array<{ id: string; name: string; input: unknown }> }
): boolean {
  return result.text.length === 0 && result.toolCalls.length === 0;
}

function emptyGenerationError(candidate: CandidateModel, usage: UsageSummary, detail: Record<string, unknown> = {}): GatewayError {
  return new GatewayError(
    'upstream_error',
    `Upstream model "${bareModelName(candidate.publicModelId)}" returned no generated output`,
    { status: 502, code: 'upstream_empty_response', cause: { ...detail, stage: 'no_generation_at_eof', usage: { ...usage, total: usage.total || usage.input + usage.output } } },
  );
}

function badGenerationError(message: string, stage: string, detail: Record<string, unknown> = {}): GatewayError {
  return new GatewayError('upstream_error', message, { status: 502, code: 'upstream_bad_response', cause: { ...detail, stage } });
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLengthFinish(reason: string | null): boolean {
  return reason === 'length' || reason === 'max_tokens';
}

// Provider-controlled labels may be useful for correlation, but never log raw
// response fields or allow newlines/control characters in diagnostic lines.
function diagnosticLabel(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return Array.from(redactString(value).slice(0, 160), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? '?' : char;
  }).join('');
}

function hasTools(req: CanonicalRequest): boolean {
  if (req.tools && req.tools.length > 0) return true;
  for (const m of req.messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' || b.type === 'tool_result') return true;
    }
  }
  return false;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// docs/13 §11: safe provider key fingerprint — never the key itself.
function apiKeyFingerprint(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return `fp_${h.toString(16).padStart(8, '0')}…${key.slice(-4).replace(/./g, '*')}${key.length}ch`;
}

// docs/13 §12: upstream request summary + optional full body
function logUpstreamRequest(
  requestId: string,
  cfg: ReturnType<typeof providerToUpstreamConfig>,
  url: string,
  payload: unknown,
  stream: boolean
): void {
  const json = JSON.stringify(payload ?? {});
  debugUpstream(requestId, 'UPSTREAM REQUEST', [
    `method=POST`,
    `url=${url}`,
    `type=${cfg.type}`,
    `stream=${stream}`,
    `contentLength=${json.length}`,
    `customHeaders=${JSON.stringify(Object.keys(cfg.customHeaders ?? {}))}`,
  ]);
  if (getDebugFlags().httpBody) {
    const LIMIT = 512 * 1024;
    debugBody(requestId, 'UPSTREAM BODY', [
      json.length > LIMIT ? `${json.slice(0, LIMIT)}…(+${json.length - LIMIT} chars, truncated)` : json,
    ]);
  }
}

/**
 * Safely parse capabilities JSON. Returns minimal default if parsing fails.
 * CRITICAL: Must return a complete default object with all capability fields,
 * otherwise undefined values will cause modelMeets() to fail incorrectly.
 */
function safeJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    // Ensure all required fields exist, using true as default for "unknown"
    const result: Record<string, unknown> = {
      chat: true,
      streaming: true,
      tools: true,
      structured_output: true,
      image_input: true,
      audio_input: true,
      reasoning: true,
      responses: true,
      ...parsed,
    };
    return result;
  } catch {
    // Fallback to defaults if completely unparseable
    return {
      chat: true,
      streaming: true,
      tools: true,
      structured_output: true,
      image_input: true,
      audio_input: true,
      reasoning: true,
      responses: true,
    };
  }
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function usageFromCache(u: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | null): UsageSummary {
  return u ? { ...u, total: u.input + u.output } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

// SSE encoders: canonical stream chunk -> client protocol event
function openaiStreamEncoder(data: string, _event?: string): string {
  if (data === '[DONE]') return 'data: [DONE]\n\n';
  return `data: ${data}\n\n`;
}

function anthropicStreamEncoder(data: string, event?: string): string {
  if (data === '[DONE]') return 'data: [DONE]\n\n';
  return `${event && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(event) && event !== 'message' ? `event: ${event}\n` : ''}data: ${data}\n\n`;
}
