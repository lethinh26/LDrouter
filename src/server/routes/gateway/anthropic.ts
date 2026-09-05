// Anthropic-compatible gateway routes: /v1/messages, /v1/messages/count_tokens.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateGatewayKey, type AuthenticatedKey } from '../../auth/api-key';
import { resolveClientIp } from '../../util/client-ip';
import { anthropicToCanonical, type AnthropicRequest } from '../../protocols/anthropic';
import { GatewayError, toAnthropicError } from '../../errors';
import { GatewayRunner, type GatewayContext } from '../../gateway/runner';
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
  thinking: z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().min(1) }).optional(),
  // Accept additional fields
}).passthrough();

const CountTokensBody = MessagesBody.omit({ stream: true });

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
    const key = authenticateGatewayHeaders(req);
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
      const outcome = await runner.execute({ canonical, protocol: 'anthropic', endpoint: 'messages' }, ctx);
      if (body.stream) {
        if (reply.raw.headersSent || reply.raw.writableEnded) {
          reply.hijack();
          return reply;
        }
        if (!outcome.success) {
          const g = new GatewayError((outcome.errorType as never) ?? 'gateway_error', outcome.errorMessage ?? 'Gateway error', { status: outcome.httpStatus });
          reply.code(outcome.httpStatus).send(toAnthropicError(g, ctx.requestId));
          return;
        }
        reply.type('text/event-stream').send('data: [DONE]\n\n');
        return;
      }
      if (!outcome.success) {
        const g = new GatewayError((outcome.errorType as never) ?? 'gateway_error', outcome.errorMessage ?? 'Gateway error', { status: outcome.httpStatus });
        lifecycle(requestId, 'DONE', [`status=${outcome.httpStatus} durationMs=${outcome.latencyMs} error=true type=${g.type}`]);
        reply.code(outcome.httpStatus).send(toAnthropicError(g, ctx.requestId));
        return;
      }
      lifecycle(requestId, 'DONE', [`status=200 durationMs=${outcome.latencyMs} finishReason=${outcome.finishReason ?? 'null'}`]);
      reply.header('x-request-id', ctx.requestId);
      reply.send({
        id: `msg_${ctx.requestId}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
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
    const body = CountTokensBody.parse(req.body);
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

function authenticateGatewayHeaders(req: { headers: Record<string, string | string[] | undefined> }): AuthenticatedKey {
  const key = authenticateGatewayKey(req);
  if (!key) throw new GatewayError('authentication_error', 'Missing API key', { status: 401 });
  if (!key.enabled) throw new GatewayError('authentication_error', 'API key disabled', { status: 401 });
  if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) throw new GatewayError('authentication_error', 'API key expired', { status: 401 });
  return key;
}
