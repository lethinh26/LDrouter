// Anthropic-compatible gateway routes: /v1/messages, /v1/messages/count_tokens.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../db';
import { requireGatewayKey, keyAllowedForTarget } from '../../auth/api-key';
import { resolveRequestedModel } from '../../routing/resolver';
import { resolveClientIp } from '../../util/client-ip';
import { anthropicToCanonical, type AnthropicRequest } from '../../protocols/anthropic';
import { GatewayError, toAnthropicError, outcomeError } from '../../errors';
import { GatewayRunner, type GatewayContext } from '../../gateway/runner';
import { providerIntegration } from '../../providers/integration';
import { providerToUpstreamConfig, callUpstreamNonStreaming, upstreamHttpError, retryAfterMs } from '../../upstream/client';
import { checkRpm, acquireConcurrent, releaseConcurrent } from '../../routing/ratelimit';
import { uuid } from '../../auth/ids';
import { lifecycle, debugHttp, debugBody, getDebugFlags, summarizeMessages, summarizeTools, summarizeHeaders, sanitizeJson, truncate } from '../../logging/debug';

const MessagesBody = z.object({
  model: z.string().min(1),
  messages: z.array(z.any()).min(1),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  max_tokens: z.number().int().min(1).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  thinking: z.union([z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().min(1) }).passthrough(), z.object({ type: z.enum(['adaptive', 'disabled']) }).passthrough()]).optional(),
  // Accept additional fields
}).passthrough();

const CountTokensBody = MessagesBody.omit({ stream: true });

function nativeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const version = headers['anthropic-version'];
  const beta = headers['anthropic-beta'];
  if (typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version)) result['anthropic-version'] = version;
  if (typeof beta === 'string' && beta.length <= 1024 && /^[a-zA-Z0-9_, -]+$/.test(beta)) result['anthropic-beta'] = beta;
  return result;
}

export async function registerAnthropicRoutes(app: FastifyInstance): Promise<void> {
  const runner = new GatewayRunner();

  app.get('/v1/messages', async (_req, reply) => {
    reply.code(405).send(toAnthropicError(new GatewayError('invalid_request_error', 'Use POST /v1/messages', { status: 405 }), ''));
  });

  app.post('/v1/messages', async (req, reply) => {
    const requestId = (req.id as string) || uuid();
    lifecycle(requestId, 'INCOMING', [
      `POST ${req.url}`,
      ...summarizeHeaders(req.headers as Record<string, unknown>),
    ]);
    const key = requireGatewayKey(req);
    const body = MessagesBody.parse(req.body);
    logIncomingMessagesBody(requestId, body);
    const ar: AnthropicRequest = body as never;
    if (!ar.max_tokens) {
      throw new GatewayError('invalid_request_error', 'max_tokens is required', { status: 400 });
    }
    const canonical = anthropicToCanonical(ar);
    const ctx: GatewayContext = {
      requestId,
      clientIp: resolveClientIp(req),
      protocol: 'anthropic',
      endpoint: 'messages',
      requestedModel: body.model,
      key,
      reply,
    };
    try {
      const outcome = await runner.execute({ canonical, protocol: 'anthropic', endpoint: 'messages', nativeMessages: body, anthropicHeaders: nativeHeaders(req.headers) }, ctx);
      if (body.stream) {
        if (reply.raw.headersSent || reply.raw.writableEnded) {
          reply.hijack();
          return reply;
        }
        if (!outcome.success) {
          const g = outcomeError(outcome);
          reply.code(outcome.httpStatus).send(toAnthropicError(g, ctx.requestId));
          return;
        }
        reply.type('text/event-stream').send('data: [DONE]\n\n');
        return;
      }
      if (!outcome.success) {
        const g = outcomeError(outcome);
        lifecycle(requestId, 'DONE', [`status=${outcome.httpStatus} durationMs=${outcome.latencyMs} error=true type=${g.type}`]);
        reply.code(outcome.httpStatus).send(toAnthropicError(g, ctx.requestId));
        return;
      }
      lifecycle(requestId, 'DONE', [`status=200 durationMs=${outcome.latencyMs} finishReason=${outcome.finishReason ?? 'null'}`]);
      reply.header('x-request-id', ctx.requestId);
      if (outcome.nativeMessage) return reply.send({ ...outcome.nativeMessage, model: body.model });
      reply.send({
        id: `msg_${ctx.requestId}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
          ...(outcome.thinkingBlocks ?? []),
          ...(outcome.text ? [{ type: 'text', text: outcome.text }] : []),
          ...(outcome.toolCalls ?? []).map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })),
        ],
        stop_reason: outcome.finishReason,
        usage: {
          input_tokens: outcome.usage.input,
          output_tokens: outcome.usage.output,
          ...(outcome.usage.cacheRead ? { cache_read_input_tokens: outcome.usage.cacheRead } : {}),
          ...(outcome.usage.cacheWrite ? { cache_creation_input_tokens: outcome.usage.cacheWrite } : {}),
        },
      });
    } catch (e) {
      if (e instanceof GatewayError) {
        reply.code(e.status).send(toAnthropicError(e, ctx.requestId));
        return;
      }
      throw e;
    }
  });

  app.post('/v1/messages/count_tokens', async (req, reply) => {
    const key = requireGatewayKey(req);
    const body = CountTokensBody.parse(req.body);
    const target = resolveRequestedModel(body.model);
    if (!keyAllowedForTarget(key, target)) throw new GatewayError('permission_error', 'Model not permitted for this API key', { status: 403 });
    const resolved = target.kind === 'alias' ? target.resolved : target;
    if (resolved.kind === 'model') {
      const db = getDb();
      const model = db.select().from(schema.models).where(eq(schema.models.id, resolved.modelId)).get();
      const provider = model && db.select().from(schema.providers).where(eq(schema.providers.id, model.providerId)).get();
      if (model && provider && providerIntegration(provider).providerKind === 'claude_code') {
        if (!model.enabled || !model.upstreamAvailable || !provider.enabled) throw new GatewayError('upstream_unavailable', 'Claude model is unavailable', { status: 503 });
        if (!checkRpm(key.id, key.rpmLimit).allowed) throw new GatewayError('rate_limit_error', 'Rate limit exceeded (RPM)', { status: 429 });
        if (!acquireConcurrent(key.id, key.maxConcurrent)) throw new GatewayError('rate_limit_error', 'Too many concurrent requests', { status: 429 });
        try {
          const cfg = providerToUpstreamConfig(provider);
          if (!cfg.apiKey || !/^sk-ant-api[A-Za-z0-9_-]+$/.test(cfg.apiKey)) throw new GatewayError('authentication_error', 'Claude Code requires an Anthropic API key', { status: 400 });
          const payload: Record<string, unknown> = { ...body, model: model.upstreamModelId };
          delete payload.stream; delete payload.max_tokens;
          const call = await callUpstreamNonStreaming({ ...cfg, nativeClaude: true, customHeaders: { 'anthropic-version': '2023-06-01', ...nativeHeaders(req.headers) } }, 'https://api.anthropic.com/v1/messages/count_tokens', payload, String(req.id));
          if (!call.ok) throw upstreamHttpError(call.status, '', { status: call.status, retryAfterMs: retryAfterMs(call.headers['retry-after']) });
          const result = z.object({ input_tokens: z.number().int().nonnegative() }).parse(JSON.parse(call.text));
          return reply.send(result);
        } finally { releaseConcurrent(key.id); }
      }
    }
    const ar: AnthropicRequest = body as never;
    const canonical = anthropicToCanonical(ar);
    // Estimate: 1 token per 4 chars, conservative for v1 without provider call.
    const json = JSON.stringify(canonical.messages) + (canonical.system ?? '');
    const inputTokens = Math.ceil(json.length / 4);
    reply.header('x-request-id', req.id as string);
    reply.send({ input_tokens: inputTokens });
  });
}
// docs/13 §4–§7: incoming /v1/messages body structure logging.
function logIncomingMessagesBody(requestId: string, body: Record<string, unknown>): void {
  debugHttp(requestId, 'BODY SUMMARY', [
    `model=${JSON.stringify(body['model'])}`,
    `stream=${JSON.stringify(body['stream'])}`,
    `max_tokens=${JSON.stringify(body['max_tokens'])}`,
    `temperature=${JSON.stringify(body['temperature'])}`,
    `top_p=${JSON.stringify(body['top_p'])}`,
    `thinking=${JSON.stringify(body['thinking'])}`,
    `tool_choice=${JSON.stringify(body['tool_choice'])}`,
    `systemType=${Array.isArray(body['system']) ? `array(${(body['system'] as unknown[]).length})` : typeof body['system']}`,
    `bodyKeys=[${Object.keys(body).map((k) => JSON.stringify(k)).join(', ')}]`,
    `messages=${Array.isArray(body['messages']) ? (body['messages'] as unknown[]).length : 'undefined'}`,
    `tools=${Array.isArray(body['tools']) ? (body['tools'] as unknown[]).length : 'undefined'}`,
  ]);
  debugHttp(requestId, 'MESSAGES', summarizeMessages(body));
  if (body['tools'] !== undefined) debugHttp(requestId, 'TOOLS', summarizeTools(body));
  if (getDebugFlags().httpBody) {
    const json = sanitizeJson(body);
    const bodySize = json.length;
    const LIMIT = 512 * 1024; // generous debug-only cap (docs/13 §5)
    debugBody(requestId, 'INCOMING BODY', [
      `bodySize=${bodySize} bytes bodyTruncated=${bodySize > LIMIT}`,
      bodySize > LIMIT ? truncate(json, LIMIT) : json,
    ]);
  }
}
