// Gateway execution pipeline: auth -> resolve -> ACL -> limits -> route -> attempt -> persist.

import { getDb, schema } from '../db/index';
import { eq } from 'drizzle-orm';
import { GatewayError } from '../errors';
import { resolveRequestedModel, unwrapAlias } from '../routing/resolver';
import { deriveRequiredCapabilities, modelMeets, type CanonicalRequest, type RequiredCapabilities } from '../routing/capabilities';
import { loadCombo, selectCandidates, orderCandidates, shouldFallback, type ComboPlan, type CandidateModel } from '../routing/combo';
import { getEffectiveState, isOpen, recordSuccess, recordFailure, halfOpenProbeAllowed } from '../routing/circuit';
import { checkRpm, checkTpm, acquireConcurrent, releaseConcurrent } from '../routing/ratelimit';
import { checkDailyMonthly, consumeUsage } from '../routing/quota';
import { keyAllowedFor, type AuthenticatedKey } from '../auth/api-key';
import { providerToUpstreamConfig, callUpstreamNonStreaming, callUpstreamStreaming, upstreamUrl, type UpstreamCall } from '../upstream/client';
import { canonicalToOpenAIRequest, openAIResponseToCanonical } from '../protocols/canonical';
import { canonicalToAnthropicRequest, anthropicResponseToCanonical } from '../protocols/anthropic';
import { uuid } from '../auth/ids';
import { redactString, redactValue } from '../security/redact';
import { getSettings } from '../db/repositories/settings';
import { buildCacheKey, lookupCache, storeCache, cacheAllowed } from '../caching/store';
import { metrics } from '../metrics/registry';
import type { FastifyReply } from 'fastify';
import { emitRequestLogged, emitRequestStarted } from './events';
import { debugHttp, debugBody, debugUpstream, debugStream, errorLine, formatError, getDebugFlags, truncate } from '../logging/debug';

export interface GatewayContext {
  requestId: string;
  clientIp: string;
  protocol: 'openai' | 'anthropic';
  endpoint: string;
  requestedModel: string;
  key: AuthenticatedKey | null;
  reply: FastifyReply;
}

export interface GatewayRequest {
  canonical: CanonicalRequest;
  protocol: 'openai' | 'anthropic';
  endpoint: 'chat/completions' | 'responses' | 'messages';
}

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
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
  result?: { text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; finishReason: string | null };
}

export interface GatewayOutcome {
  success: boolean;
  httpStatus: number;
  errorType: string | null;
  errorMessage: string | null;
  text: string | null;
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
    metrics.activeRequests.inc();
    let concurrencyAcquired = false;

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
    if (ctx.key) {
      if (resolved.kind === 'model') {
        if (!keyAllowedFor(ctx.key, 'model', resolved.modelId)) throw new GatewayError('permission_error', 'Model not permitted for this API key', { status: 403 });
      } else if (resolved.kind === 'combo') {
        if (!keyAllowedFor(ctx.key, 'combo', resolved.comboId)) throw new GatewayError('permission_error', 'Combo not permitted for this API key', { status: 403 });
      }
    }

    // --- Limits: RPM / TPM / concurrency / quota ---
    if (ctx.key) {
      const rpm = checkRpm(ctx.key.id, ctx.key.rpmLimit);
      if (!rpm.allowed) {
        metrics.rateLimited.inc({ reason: 'rpm' });
        const err = new GatewayError('rate_limit_error', 'Rate limit exceeded (RPM)', { status: 429, code: 'rpm_limit' });
        (err as { retryAfter?: number }).retryAfter = rpm.retryAfterSeconds;
        throw err;
      }
      // Estimate input tokens for TPM: conservative approximation (4 chars/token)
      const estimatedInput = estimateTokens(JSON.stringify(req.canonical.messages));
      const tpm = checkTpm(ctx.key.id, ctx.key.tpmLimit, estimatedInput + (req.canonical.maxOutputTokens ?? 1024));
      if (!tpm.allowed) {
        metrics.rateLimited.inc({ reason: 'tpm' });
        const err = new GatewayError('rate_limit_error', 'Rate limit exceeded (TPM)', { status: 429, code: 'tpm_limit' });
        (err as { retryAfter?: number }).retryAfter = tpm.retryAfterSeconds;
        throw err;
      }
      const quota = checkDailyMonthly(ctx.key.id, ctx.key.dailyTokenLimit, ctx.key.monthlyTokenLimit, estimatedInput + (req.canonical.maxOutputTokens ?? 1024));
      if (!quota.allowed) {
        metrics.rateLimited.inc({ reason: quota.reason ?? 'quota' });
        throw new GatewayError('rate_limit_error', `Quota exceeded (${quota.reason})`, { status: 429, code: 'quota_limit' });
      }
      if (!acquireConcurrent(ctx.key.id, ctx.key.maxConcurrent)) {
        metrics.rateLimited.inc({ reason: 'concurrency' });
        throw new GatewayError('rate_limit_error', 'Too many concurrent requests', { status: 429, code: 'concurrency_limit' });
      }
      concurrencyAcquired = true;
    }

    try {
      // --- Capability requirements ---
      const required = deriveRequiredCapabilities(req.canonical);
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
      let selectionReasons: string[] = [];
      if (resolved.kind === 'model') {
        candidates = await this.loadModelCandidate(resolved.modelId, required, ctx.requestId);
        selectionReasons.push('direct_model');
        if (candidates.length === 0) {
          debugHttp(ctx.requestId, 'CAPABILITY REJECT', [
            `model=${resolved.publicModelId}`,
            `reason=direct_model_unavailable_or_capability_mismatch`,
            '(direct model candidates rejected: not found / provider disabled / model disabled / upstream unavailable / circuit open / capability mismatch)',
          ]);
        }
      } else if (comboPlan) {
        const all = await this.loadAllModels();
        const rejected: Array<{ publicModelId: string; reason: string }> = [];
        const filtered = selectCandidates(comboPlan, all, required, (c, reason) => {
          rejected.push({ publicModelId: c.publicModelId, reason });
          debugHttp(ctx.requestId, 'CAPABILITY REJECT', [`model=${c.publicModelId}`, `reason=${reason}`]);
        });
        // docs/13 §10: always report why EACH member was filtered out
        debugHttp(ctx.requestId, 'CANDIDATE FILTER', [
          `comboMembers=${comboPlan.members.length}`,
          `afterFilter=${filtered.length}`,
          `rejectedCount=${rejected.length}`,
          ...rejected.map((r) => `rejected: ${r.publicModelId} reason=${r.reason}`),
        ]);
        if (filtered.length === 0) {
          throw new GatewayError('capability_not_supported', 'No combo member satisfies the request capabilities or availability', { status: 400 });
        }
        candidates = orderCandidates(comboPlan, filtered);
        debugHttp(ctx.requestId, 'CANDIDATES ORDERED', [
          `mode=${comboPlan.mode}`,
          ...candidates.map((c, i) => `candidate[${i}]: providerModelId=${c.modelId} publicModelId=${c.publicModelId}`),
        ]);
        selectionReasons.push('combo');
      }

      if (candidates.length === 0) {
        throw new GatewayError('upstream_unavailable', 'No available model candidates', { status: 502 });
      }

      // --- Gateway response cache check ---
      const settings = getSettings();
      const keyCacheOverride = ctx.key?.cacheOverrideEnabled ?? null;
      const targetCacheOverride = this.getTargetCacheOverride(resolved);
      const allowed = cacheAllowed({
        globalEnabled: settings.gatewayCacheEnabled,
        keyAllowed: keyCacheOverride,
        targetAllowed: targetCacheOverride,
        streaming: req.canonical.stream,
      });
      if (allowed && !req.canonical.stream && !hasTools(req.canonical)) {
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
          metrics.cacheHits.inc();
          const g = this.cachedToOutcome(cached.payload, cached.usage, ctx, resolved, start);
          await this.persistRequest(req, ctx, resolved, g, usageFromCache(cached.usage), attempts, true);
          metrics.activeRequests.dec();
          return g;
        }
        // remember cacheKey for storing after success
        (req as unknown as { _cacheKey?: string; _cacheConfigVersion?: number })._cacheKey = cacheKey;
        (req as unknown as { _cacheKey?: string; _cacheConfigVersion?: number })._cacheConfigVersion = configVersion;
      }

      // --- Attempt loop with fallback ---
      const maxAttempts = comboPlan?.maxTotalAttempts ?? (candidates.length > 1 ? 2 : 1);
      let lastError: GatewayError | null = null;
      let sentToClient = false; // semantically committed output sent
      let resultText = '';
      let resultToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      let resultFinishReason: string | null = null;
      let finalModelId: string | null = null;

      for (let i = 0; i < maxAttempts && i < candidates.length; i++) {
        const candidate = candidates[i]!;
        finalModelId = candidate.modelId;
        const provider = getDb().select().from(schema.providers).where(eq(schema.providers.id, candidate.providerId)).get();
        if (!provider || !provider.enabled) {
          debugHttp(ctx.requestId, 'ATTEMPT SKIP', [`attempt=${i + 1} model=${candidate.publicModelId} reason=skipped_disabled_provider`]);
          attempts.push(this.failedAttempt(i + 1, candidate, provider?.name ?? '', 'skipped_disabled_provider', null, null, 0, null, null));
          continue;
        }
        const eff = getEffectiveState(provider.id, provider.cbCooldownSeconds);
        if (eff === 'open' && !halfOpenProbeAllowed(provider.id)) {
          debugHttp(ctx.requestId, 'ATTEMPT SKIP', [`attempt=${i + 1} model=${candidate.publicModelId} provider=${provider.name} reason=circuit_open`]);
          attempts.push(this.failedAttempt(i + 1, candidate, provider.name, 'circuit_open', null, null, 0, null, null));
          if (comboPlan && shouldFallback(comboPlan, { type: 'connection_error' })) {
            metrics.fallbackCount.inc();
            continue;
          }
          lastError = new GatewayError('upstream_unavailable', 'Provider circuit is open', { status: 502 });
          break;
        }

        const cfg = providerToUpstreamConfig(provider);
        const attemptStart = Date.now();
        // docs/13 §11–§12: provider/account + upstream request summary
        const upstreamModel = candidate.publicModelId.split('/').slice(1).join('/');
        debugHttp(ctx.requestId, 'ATTEMPT', [
          `attempt=${i + 1}/${maxAttempts}`,
          `provider=${provider.name}`,
          `providerId=${provider.id}`,
          `model=${candidate.publicModelId}`,
          `upstreamModel=${upstreamModel}`,
          `upstreamType=${cfg.type}`,
          `baseUrl=${cfg.baseUrl}`,
          `stream=${req.canonical.stream}`,
          `providerKeyFingerprint=${apiKeyFingerprint(cfg.apiKey)}`,
        ]);
        const attempt: AttemptOutcome = {
          attemptNumber: i + 1,
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
          selectionReason: selectionReasons[0] ?? 'direct',
          failureReason: null,
          sanitizedError: null,
          upstreamRequestId: null,
        };

        try {
          const out = await this.runOneAttempt(req, ctx, candidate, provider.name, cfg, required, (isStreamStarted) => {
            attempt.streamStarted = isStreamStarted;
            attempt.ttftMs = Date.now() - attemptStart;
          }, (ttftMs) => {
            // Live signal for the monitoring dashboard: the request is now
            // being served by this provider (lit up from TTFT until the
            // completion event fires on persist).
            emitRequestStarted(ctx.requestId, provider.id, candidate.modelId, ctx.requestedModel, ttftMs);
          });
          attempt.statusCode = (out as { statusCode?: number | null }).statusCode ?? null;
          attempt.success = true;
          attempt.latencyMs = Date.now() - attemptStart;
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
          resultText = out.result.text;
          resultToolCalls = out.result.toolCalls;
          resultFinishReason = out.result.finishReason;
          recordSuccess(provider.id);
          getDb().update(schema.providers).set({ healthState: 'healthy', updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, provider.id)).run();
          attempts.push(attempt);
          sentToClient = (out as { streamStarted?: boolean }).streamStarted ?? false;
          break;
        } catch (e) {
          const err = e instanceof GatewayError ? e : new GatewayError('upstream_error', (e as Error).message, { cause: e });
          debugUpstream(ctx.requestId, 'ATTEMPT ERROR', [
            `attempt=${i + 1}`,
            `provider=${provider.name}`,
            `model=${candidate.publicModelId}`,
            `type=${err.type}`,
            `status=${err.status}`,
            `willFallback=${comboPlan ? shouldFallback(comboPlan, { type: classifyFailure(err), status: err.status }) : false}`,
          ]);
          const shouldRetry = comboPlan ? shouldFallback(comboPlan, { type: classifyFailure(err), status: err.status }) : false;
          attempt.statusCode = err.status;
          attempt.success = false;
          attempt.latencyMs = Date.now() - attemptStart;
          attempt.completedAt = new Date().toISOString();
          attempt.failureReason = classifyFailure(err);
          attempt.sanitizedError = redactString(err.message);
          // If stream already started sending content, do NOT fallback
          if (attempt.streamStarted) {
            attempt.partialResponse = true;
            attempts.push(attempt);
            sentToClient = true;
            void sentToClient;
            lastError = err;
            break;
          }
          attempts.push(attempt);
          lastError = err;
          recordFailure(provider.id, provider.cbFailureThreshold, provider.cbCooldownSeconds);
          getDb().update(schema.providers).set({ healthState: 'down', updatedAt: new Date().toISOString() }).where(eq(schema.providers.id, provider.id)).run();
          if (shouldRetry && i + 1 < maxAttempts) {
            metrics.fallbackCount.inc();
            continue;
          }
          break;
        }
      }

      // Build outcome
      const latencyMs = Date.now() - start;
      const outcome: GatewayOutcome = {
        success: !lastError,
        httpStatus: lastError ? lastError.status : 200,
        errorType: lastError?.type ?? null,
        errorMessage: lastError ? redactString(lastError.message) : null,
        text: lastError ? null : resultText,
        toolCalls: lastError ? null : resultToolCalls,
        finishReason: lastError ? null : resultFinishReason,
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
      if (outcome.success && cacheMeta._cacheKey && !req.canonical.stream && !hasTools(req.canonical)) {
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
      if (ctx.key) consumeUsage(ctx.key.id, usage.input, usage.output);

      return outcome;
    } finally {
      if (concurrencyAcquired && ctx.key) releaseConcurrent(ctx.key.id);
      metrics.activeRequests.dec();
    }
  }

  private async loadModelCandidate(modelId: string, required: RequiredCapabilities, requestId?: string): Promise<CandidateModel[]> {
    const db = getDb();
    const reject = (reason: string) => {
      if (requestId) debugHttp(requestId, 'CAPABILITY REJECT', [`modelId=${modelId}`, `reason=${reason}`]);
    };
    const m = db.select().from(schema.models).where(eq(schema.models.id, modelId)).get();
    if (!m) { reject('model_not_found'); return []; }
    const p = db.select().from(schema.providers).where(eq(schema.providers.id, m.providerId)).get();
    if (!p) { reject('provider_not_found'); return []; }
    if (!p.enabled) { reject('provider_disabled'); return []; }
    const caps = safeJson(m.capabilitiesJson);
    const candidate: CandidateModel = {
      modelId: m.id,
      publicModelId: m.publicModelId,
      providerId: m.providerId,
      enabled: m.enabled,
      upstreamAvailable: m.upstreamAvailable,
      circuitOpen: isOpen(m.providerId),
      capabilities: caps as never,
    };
    if (!m.enabled) { reject('model_disabled'); return []; }
    if (!m.upstreamAvailable) { reject('upstream_unavailable'); return []; }
    if (candidate.circuitOpen) { reject('circuit_open'); return []; }
    if (!modelMeets(caps, required)) { reject('capability_mismatch'); return []; }
    debugHttp(requestId ?? '-', 'CAPABILITY CANDIDATE', [
      `model=${m.publicModelId}`,
      `caps.tools=${(caps as { tools?: boolean }).tools}`,
      `caps.streaming=${(caps as { streaming?: boolean }).streaming}`,
      `caps.reasoning=${(caps as { reasoning?: boolean }).reasoning}`,
      `caps.image_input=${(caps as { image_input?: boolean }).image_input}`,
      `caps.structured_output=${(caps as { structured_output?: boolean }).structured_output}`,
    ]);
    return [candidate];
  }

  private async loadAllModels(): Promise<CandidateModel[]> {
    const db = getDb();
    const models = db.select().from(schema.models).all();
    const providers = db.select().from(schema.providers).all();
    const providerEnabled = new Map(providers.map((p) => [p.id, p.enabled]));
    return models.map((m) => ({
      modelId: m.id,
      publicModelId: m.publicModelId,
      providerId: m.providerId,
      enabled: m.enabled,
      upstreamAvailable: m.upstreamAvailable,
      circuitOpen: isOpen(m.providerId),
      capabilities: safeJson(m.capabilitiesJson) as never,
    })).filter((m) => m.enabled && m.upstreamAvailable && providerEnabled.get(m.providerId));
  }

  private async runOneAttempt(
    req: GatewayRequest,
    ctx: GatewayContext,
    candidate: CandidateModel,
    providerName: string,
    cfg: ReturnType<typeof providerToUpstreamConfig>,
    required: RequiredCapabilities,
    onStreamStart: (started: boolean) => void,
    onFirstToken: (ttftMs: number) => void
  ): Promise<{ statusCode: number; ttftMs: number | null; upstreamRequestId: string | null; usage: UsageSummary; result: { text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; finishReason: string | null } }> {
    if (req.canonical.stream) {
      return this.runStreamingAttempt(req, ctx, candidate, cfg, onStreamStart, onFirstToken);
    }
    return this.runNonStreamingAttempt(req, candidate, cfg, ctx);
  }

  private async runNonStreamingAttempt(
    req: GatewayRequest,
    candidate: CandidateModel,
    cfg: ReturnType<typeof providerToUpstreamConfig>,
    ctx: GatewayContext
  ): Promise<{ statusCode: number; ttftMs: number | null; upstreamRequestId: string | null; usage: UsageSummary; result: { text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; finishReason: string | null } }> {
    const upstreamModel = candidate.publicModelId.split('/').slice(1).join('/');
    let call: UpstreamCall;
    if (cfg.type === 'openai') {
      const payload = canonicalToOpenAIRequest(req.canonical, upstreamModel);
      logUpstreamRequest(ctx.requestId, cfg, upstreamUrl(cfg, '/v1/chat/completions'), payload, req.canonical.stream);
      call = await callUpstreamNonStreaming(cfg, upstreamUrl(cfg, '/v1/chat/completions'), payload, ctx.requestId);
    } else {
      const payload = canonicalToAnthropicRequest(req.canonical, upstreamModel);
      logUpstreamRequest(ctx.requestId, cfg, upstreamUrl(cfg, '/v1/messages'), payload, req.canonical.stream);
      call = await callUpstreamNonStreaming(cfg, upstreamUrl(cfg, '/v1/messages'), payload, ctx.requestId);
    }
    if (!call.ok) {
      if (call.status === 429) throw new GatewayError('upstream_rate_limit', `Upstream rate limited (HTTP ${call.status})`, { status: 429, code: 'upstream_http_429' });
      if (call.status === 401 || call.status === 403) throw new GatewayError('upstream_auth_error', 'Upstream authentication failed', { status: 502 });
      if (call.status >= 500) throw new GatewayError('upstream_error', `Upstream HTTP ${call.status}`, { status: 502, code: `upstream_http_${call.status}` });
      throw new GatewayError('upstream_error', `Upstream HTTP ${call.status}: ${redactString(call.text.slice(0, 300))}`, { status: 502 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.text);
    } catch {
      throw new GatewayError('upstream_error', 'Upstream returned invalid JSON', { status: 502 });
    }
    let result: { text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; finishReason: string | null };
    let usage: UsageSummary;
    if (cfg.type === 'openai') {
      const conv = openAIResponseToCanonical(parsed as never, req.canonical.model);
      result = { text: conv.text, toolCalls: conv.toolCalls, finishReason: conv.finishReason };
      usage = conv.usage;
    } else {
      const conv = anthropicResponseToCanonical(parsed as never, req.canonical.model);
      result = { text: conv.text, toolCalls: conv.toolCalls, finishReason: conv.finishReason };
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
  ): Promise<{ statusCode: number; ttftMs: number | null; upstreamRequestId: string | null; usage: UsageSummary; result: { text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; finishReason: string | null } }> {
    const upstreamModel = candidate.publicModelId.split('/').slice(1).join('/');
    const encoder = req.protocol === 'openai' ? openaiStreamEncoder : anthropicStreamEncoder;

    // Hard streaming invariant: the client SSE head is NOT written until the
    // upstream confirms by delivering its first chunk (or completes). Before
    // that first chunk, a pre-stream failure may fall back to the next model.
    // Once content hits the client, fallback is forbidden (see docs/04).
    const pipe = ctx.reply.raw;
    let headWritten = false;
    const writeHead = () => {
      if (headWritten) return;
      headWritten = true;
      pipe.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': ctx.requestId,
      });
    };

    let streamStarted = false;
    const streamStartTs = Date.now();
    let textBuf = '';
    const toolBuf: Array<{ id: string; name: string; input: unknown }> = [];
    let finishReason: string | null = null;
    const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };

    // docs/13 §15–§16: stream counters + client disconnect tracking
    let chunkCount = 0;
    let bytesReceived = 0;
    let firstChunkTime: number | null = null;
    let lastChunkTime: number | null = null;
    const loggedFirstChunks: string[] = [];
    let clientDisconnected = false;
    // Guard: the admin test-stream endpoint passes a minimal `fakeRaw` that has
    // writeHead/write/end but no `.on` — skip disconnect tracking in that case.
    if (typeof (pipe as { on?: unknown }).on === 'function') {
      pipe.on('close', () => {
        // Distinguish client disconnect from normal end: 'close' fires on the raw
        // socket when the client (or upstream) side goes away.
        if (!pipe.writableEnded) {
          clientDisconnected = true;
          debugStream(ctx.requestId, 'CLIENT DISCONNECT', [
            `afterMs=${Date.now() - streamStartTs}`,
            `streaming=${streamStarted}`,
            `chunksSoFar=${chunkCount}`,
          ]);
        }
      });
    }

    const chunkHandler = (chunk: { data: string; event?: string }, isFirst: boolean) => {
      chunkCount++;
      bytesReceived += chunk.data.length;
      lastChunkTime = Date.now();
      if (isFirst) firstChunkTime = Date.now() - streamStartTs;
      if (loggedFirstChunks.length < 3) {
        loggedFirstChunks.push(chunk.data);
        debugStream(ctx.requestId, `STREAM FIRST CHUNK ${loggedFirstChunks.length}`, [truncate(chunk.data, 2000)]);
      }
      try {
        const obj = JSON.parse(chunk.data);
        if (cfg.type === 'openai') {
          const choice = obj.choices?.[0];
          if (choice?.delta?.content) textBuf += choice.delta.content;
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const id = typeof tc.id === 'string' ? tc.id : `toolu-${Math.random().toString(36).slice(2)}`;
              const name = typeof tc.function?.name === 'string' ? tc.function.name : 'unknown';
              let input = {};
              if (typeof tc.function?.arguments === 'string') {
                try { input = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
              } else if (typeof tc.function?.arguments === 'object') {
                input = tc.function.arguments;
              }
              toolBuf.push({ id, name, input });
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (obj.usage) {
            usage.input = obj.usage.prompt_tokens ?? usage.input;
            usage.output = obj.usage.completion_tokens ?? usage.output;
            usage.cacheRead = obj.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheRead;
            usage.reasoning = obj.usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning;
            usage.total = obj.usage.total_tokens ?? usage.total;
          }
        } else {
          // anthropic stream events
          if (obj.type === 'content_block_delta' && obj.delta?.text) textBuf += obj.delta.text;
          if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') toolBuf.push({ id: obj.content_block.id, name: obj.content_block.name, input: obj.content_block.input ?? {} });
          if (obj.type === 'message_delta' && obj.delta?.stop_reason) finishReason = obj.delta.stop_reason;
          if (obj.type === 'message_start' && obj.message?.usage) {
            usage.input = obj.message.usage.input_tokens ?? 0;
            usage.cacheRead = obj.message.usage.cache_read_input_tokens ?? 0;
            usage.cacheWrite = obj.message.usage.cache_creation_input_tokens ?? 0;
          }
          if (obj.type === 'message_delta' && obj.usage) {
            usage.output = obj.usage.output_tokens ?? usage.output;
          }
        }
      } catch {
        // ignore parse errors in stream
      }

      // First chunk: commit the downstream SSE response and flush any buffered.
      if (isFirst) {
        streamStarted = true;
        onStreamStart(true);
        onFirstToken(Date.now() - streamStartTs);
      }
      const encoded = encoder(chunk.data, chunk.event);
      if (!headWritten) writeHead();
      if (encoded) pipe.write(encoded);
      return;
    };

    try {
      const url = cfg.type === 'openai' ? upstreamUrl(cfg, '/v1/chat/completions') : upstreamUrl(cfg, '/v1/messages');
      const payload = cfg.type === 'openai' ? canonicalToOpenAIRequest(req.canonical, upstreamModel) : canonicalToAnthropicRequest(req.canonical, upstreamModel);
      logUpstreamRequest(ctx.requestId, cfg, url, payload, true);
      debugStream(ctx.requestId, 'STREAM START', [`upstreamConnected=true`]);
      const meta = await callUpstreamStreaming(cfg, url, payload, chunkHandler, ctx.requestId);
      // Upstream completed cleanly: ensure head + terminator are written.
      if (!headWritten) writeHead();
      pipe.write('data: [DONE]\n\n');
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
        statusCode: 200,
        ttftMs: meta.ttftMs,
        upstreamRequestId: meta.upstreamRequestId,
        usage,
        result: { text: textBuf, toolCalls: toolBuf, finishReason },
      };
    } catch (e) {
      // Stream ended with failure. If we already sent content, mark partial and terminate.
      if (streamStarted) {
        // Ensure the (already-committed) response is closed.
        if (!headWritten) writeHead();
        pipe.end();
        const err = e instanceof GatewayError ? e : new GatewayError('upstream_error', (e as Error).message);
        errorLine(ctx.requestId, 'STREAM ERROR', [
          `chunksBeforeError=${chunkCount}`,
          `bytesBeforeError=${bytesReceived}`,
          `clientDisconnected=${clientDisconnected}`,
          ...formatErrorPublic(e),
        ]);
        throw err;
      }
      errorLine(ctx.requestId, 'STREAM ERROR (before first chunk)', [
        `chunksBeforeError=${chunkCount}`,
        `bytesBeforeError=${bytesReceived}`,
        `clientDisconnected=${clientDisconnected}`,
        ...formatErrorPublic(e),
      ]);
      throw e;
    }
  }

  private failedAttempt(
    n: number,
    candidate: CandidateModel,
    providerName: string,
    failureReason: string,
    statusCode: number | null,
    sanitizedError: string | null,
    latencyMs: number,
    ttftMs: number | null,
    upstreamRequestId: string | null
  ): AttemptOutcome {
    const now = new Date().toISOString();
    return {
      attemptNumber: n,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      providerName,
      startedAt: now,
      completedAt: now,
      statusCode,
      success: false,
      latencyMs,
      ttftMs,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
      streamStarted: false,
      partialResponse: false,
      selectionReason: 'candidate',
      failureReason,
      sanitizedError,
      upstreamRequestId,
    };
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
    if (settings.contentLogMode === 'prompt' || settings.contentLogMode === 'prompt_and_response') {
      requestPayload = JSON.stringify(redactValue(req.canonical));
    }
    if (settings.contentLogMode === 'prompt_and_response') {
      responsePayload = JSON.stringify(redactValue({ text: outcome.text, toolCalls: outcome.toolCalls, finishReason: outcome.finishReason }));
    }
    db.insert(schema.requests).values({
      id: requestId,
      createdAt: now,
      completedAt: now,
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
    } as never).run();

    for (const a of attempts) {
      db.insert(schema.requestAttempts).values({
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
      } as never).run();
    }

    emitRequestLogged(requestId);
  }
}

function classifyFailure(err: GatewayError): string {
  switch (err.type) {
    case 'timeout_error':
      return err.message.includes('first token') ? 'first_token_timeout' : 'connect_timeout';
    case 'upstream_unavailable':
      return 'connection_error';
    case 'upstream_rate_limit':
      return 'http_status';
    case 'upstream_error':
      return err.status >= 500 ? 'http_status' : 'connection_error';
    default:
      return 'unknown';
  }
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

/** Public alias so error formatting from debug.ts is available in this module. */
function formatErrorPublic(e: unknown): string[] {
  return formatError(e);
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

function anthropicStreamEncoder(data: string, _event?: string): string {
  if (data === '[DONE]') return 'data: [DONE]\n\n';
  return `data: ${data}\n\n`;
}
