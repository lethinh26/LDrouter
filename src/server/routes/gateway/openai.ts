// OpenAI-compatible gateway routes: /v1/models, /v1/chat/completions, /v1/responses.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { authenticateGatewayKey, type AuthenticatedKey } from '../../auth/api-key';
import { resolveClientIp } from '../../util/client-ip';
import { openAIToCanonical, openAIModelList, type OpenAIChatRequest } from '../../protocols/canonical';
import { GatewayError, toOpenAIError } from '../../errors';
import { GatewayRunner, type GatewayContext } from '../../gateway/runner';
import { uuid } from '../../auth/ids';

const ChatBody = z.object({
  model: z.string().min(1),
  messages: z.array(z.any()).min(1),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().min(1).optional(),
  stop: z.union([z.array(z.string()), z.string()]).optional(),
  response_format: z.any().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
});

const ResponsesBody = z.object({
  model: z.string().min(1),
  input: z.any(),
  stream: z.boolean().optional(),
  // Accept and pass through; full Responses support is a v1 subset.
});

export async function registerOpenAIRoutes(app: FastifyInstance): Promise<void> {
  const runner = new GatewayRunner();

  app.get('/v1/models', async (req) => {
    const key = authenticateGatewayHeaders(req);
    const db = getDb();
    let models = db.select().from(schema.models).all();
    if (!key.allowAllModels) {
      const perms = db.select().from(schema.apiKeyModelPermissions).where(eq(schema.apiKeyModelPermissions.apiKeyId, key.id)).all();
      const allowedModelIds = new Set(perms.filter((p) => p.targetKind === 'model').map((p) => p.targetId));
      models = models.filter((m) => allowedModelIds.has(m.id) || (m.enabled && m.upstreamAvailable));
    } else {
      models = models.filter((m) => m.enabled && m.upstreamAvailable);
    }
    const ids = listRoutableModelIds(models, key, db);
    return openAIModelList(ids.map((id) => ({ publicModelId: id, upstreamModelId: id })));
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const key = authenticateGatewayHeaders(req);
    const body = ChatBody.parse(req.body);
    const req1: OpenAIChatRequest = body as never;
    const canonical = openAIToCanonical(req1);
    const ctx: GatewayContext = {
      requestId: (req.id as string) || uuid(),
      clientIp: resolveClientIp(req),
      protocol: 'openai',
      endpoint: 'chat/completions',
      requestedModel: body.model,
      key,
      reply,
    };
    try {
      const outcome = await runner.execute({ canonical, protocol: 'openai', endpoint: 'chat/completions' }, ctx);
      if (req1.stream) {
        // The runner streams to reply.raw once the upstream commits. If the raw
        // response has begun (head sent or ended), it's already fully handled —
        // hijack so Fastify does not append its own reply.
        if (reply.raw.headersSent || reply.raw.writableEnded) {
          reply.hijack();
          return reply;
        }
        // Nothing was streamed: the upstream failed before the first chunk, so
        // the client should get a regular protocol error instead of a dangling
        // stream.
        if (!outcome.success) {
          const g = new GatewayError((outcome.errorType as never) ?? 'gateway_error', outcome.errorMessage ?? 'Gateway error', { status: outcome.httpStatus });
          reply.code(outcome.httpStatus).send(toOpenAIError(g, ctx.requestId));
          return;
        }
        // Success with no streamed chunks — terminate the SSE cleanly.
        reply.type('text/event-stream').send('data: [DONE]\n\n');
        return;
      }
      if (!outcome.success) {
        const g = new GatewayError((outcome.errorType as never) ?? 'gateway_error', outcome.errorMessage ?? 'Gateway error', { status: outcome.httpStatus });
        reply.code(outcome.httpStatus).send(toOpenAIError(g, ctx.requestId));
        return;
      }
      reply.header('x-request-id', ctx.requestId);
      reply.send({
        id: `chatcmpl-${ctx.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: outcome.text,
              ...(outcome.toolCalls && outcome.toolCalls.length
                ? { tool_calls: outcome.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) }
                : {}),
            },
            finish_reason: outcome.finishReason,
          },
        ],
        usage: {
          prompt_tokens: outcome.usage.input,
          completion_tokens: outcome.usage.output,
          total_tokens: outcome.usage.total,
          ...(outcome.usage.cacheRead ? { prompt_tokens_details: { cached_tokens: outcome.usage.cacheRead } } : {}),
          ...(outcome.usage.reasoning ? { completion_tokens_details: { reasoning_tokens: outcome.usage.reasoning } } : {}),
        },
      });
    } catch (e) {
      if (e instanceof GatewayError) {
        reply.code(e.status).send(toOpenAIError(e, ctx.requestId));
        return;
      }
      throw e;
    }
  });

  app.post('/v1/responses', async (req, reply) => {
    const key = authenticateGatewayHeaders(req);
    // v1 subset: accept Responses-style input, flatten to chat-completions messages.
    const body = ResponsesBody.parse(req.body);
    const flat = responsesInputToChat(body.input);
    const chatBody: OpenAIChatRequest = {
      model: body.model,
      messages: flat.messages,
      tools: flat.tools,
      stream: body.stream,
    };
    const canonical = openAIToCanonical(chatBody);
    const ctx: GatewayContext = {
      requestId: (req.id as string) || uuid(),
      clientIp: resolveClientIp(req),
      protocol: 'openai',
      endpoint: 'responses',
      requestedModel: body.model,
      key,
      reply,
    };
    try {
      const outcome = await runner.execute({ canonical, protocol: 'openai', endpoint: 'responses' }, ctx);
      if (body.stream) {
        if (reply.raw.headersSent || reply.raw.writableEnded) {
          reply.hijack();
          return reply;
        }
        if (!outcome.success) {
          const g = new GatewayError((outcome.errorType as never) ?? 'gateway_error', outcome.errorMessage ?? 'Gateway error', { status: outcome.httpStatus });
          reply.code(outcome.httpStatus).send(toOpenAIError(g, ctx.requestId));
          return;
        }
        reply.type('text/event-stream').send('data: [DONE]\n\n');
        return;
      }
      if (!outcome.success) {
        const g = new GatewayError((outcome.errorType as never) ?? 'gateway_error', outcome.errorMessage ?? 'Gateway error', { status: outcome.httpStatus });
        reply.code(outcome.httpStatus).send(toOpenAIError(g, ctx.requestId));
        return;
      }
      reply.header('x-request-id', ctx.requestId);
      reply.send({
        id: `resp-${ctx.requestId}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: outcome.text ?? '' }],
          },
        ],
        usage: {
          input_tokens: outcome.usage.input,
          output_tokens: outcome.usage.output,
          total_tokens: outcome.usage.total,
        },
      });
    } catch (e) {
      if (e instanceof GatewayError) {
        reply.code(e.status).send(toOpenAIError(e, ctx.requestId));
        return;
      }
      throw e;
    }
  });
}

// The routable surface visible to a gateway key: physical models + enabled
// combos + enabled aliases. Eligibility mirrors resolveRequestedModel() so
// every advertised id actually routes. Physical models are listed even when
// their provider is disabled — the resolver accepts them too and candidates
// get filtered at route time (explicit behavior over silent omission).
interface ModelRow { id: string; publicModelId: string }
type GatewayDb = ReturnType<typeof getDb>;
export function listRoutableModelIds(models: ModelRow[], key: AuthenticatedKey, db: GatewayDb): string[] {
  const modelIds = new Set(models.map((m) => m.id));
  const modelById = new Map(models.map((m) => [m.id, m.publicModelId]));

  let combos = db.select().from(schema.combos).where(eq(schema.combos.enabled, true)).all();
  const members = combos.length > 0
    ? db.select().from(schema.comboMembers).where(inArray(schema.comboMembers.comboId, combos.map((c) => c.id))).all()
    : [];
  const memberByCombo = new Map<string, Set<string>>();
  for (const mm of members) {
    if (!memberByCombo.has(mm.comboId)) memberByCombo.set(mm.comboId, new Set());
    memberByCombo.get(mm.comboId)!.add(mm.modelId);
  }
  // A combo with no routable members would always fail at runtime — hide it.
  combos = combos.filter((c) => {
    const ids = memberByCombo.get(c.id);
    return ids !== undefined && ids.size > 0 && [...ids].some((id) => modelIds.has(id));
  });

  let aliases = db.select().from(schema.modelAliases).where(eq(schema.modelAliases.enabled, true)).all();
  aliases = aliases.filter((a) => {
    if (a.targetKind === 'model') return modelById.has(a.targetId);
    return combos.some((c) => c.id === a.targetId);
  });

  const ids = models.map((m) => m.publicModelId).concat(combos.map((c) => c.publicModelId), aliases.map((a) => a.alias));

  if (key.allowAllModels) return ids;
  const perms = db.select().from(schema.apiKeyModelPermissions).where(eq(schema.apiKeyModelPermissions.apiKeyId, key.id)).all();
  const allowModels = new Set(perms.filter((p) => p.targetKind === 'model').map((p) => p.targetId));
  const allowCombos = new Set(perms.filter((p) => p.targetKind === 'combo').map((p) => p.targetId));
  return ids.filter((id) =>
    models.some((m) => m.publicModelId === id && allowModels.has(m.id))
    || combos.some((c) => c.publicModelId === id && allowCombos.has(c.id))
    || aliases.some((a) => a.alias === id && (a.targetKind === 'model' ? allowModels.has(a.targetId) : allowCombos.has(a.targetId))),
  );
}

function authenticateGatewayHeaders(req: { headers: Record<string, string | string[] | undefined> }): AuthenticatedKey {
  const key = authenticateGatewayKey(req);
  if (!key) throw new GatewayError('authentication_error', 'Missing API key', { status: 401 });
  if (!key.enabled) throw new GatewayError('authentication_error', 'API key disabled', { status: 401 });
  if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) throw new GatewayError('authentication_error', 'API key expired', { status: 401 });
  return key;
}

function responsesInputToChat(input: unknown): { messages: OpenAIChatRequest['messages']; tools?: OpenAIChatRequest['tools'] } {
  // Minimal Responses-to-Chat mapping (v1 subset).
  if (typeof input === 'string') return { messages: [{ role: 'user', content: input }] };
  if (Array.isArray(input)) {
    const messages: OpenAIChatRequest['messages'] = [];
    for (const item of input) {
      if (item && typeof item === 'object' && 'role' in item && 'content' in item) {
        messages.push({ role: (item as { role: 'system' | 'user' | 'assistant' }).role, content: (item as { content: unknown }).content });
      } else if (item && typeof item === 'object' && 'type' in item) {
        const t = (item as { type: string }).type;
        if (t === 'message') messages.push({ role: ((item as { role: 'user' | 'assistant' | 'system' }).role ?? 'user'), content: (item as { content: unknown }).content });
      }
    }
    return { messages };
  }
  return { messages: [{ role: 'user', content: '' }] };
}
