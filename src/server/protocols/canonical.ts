// Canonical protocol layer: OpenAI <-> canonical, Anthropic <-> canonical.

import type { CanonicalRequest, CanonicalMessage, CanonicalContentBlock, CanonicalTool } from '../routing/capabilities';
import { GatewayError } from '../errors';

export interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'; content: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }>;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[] | string;
  response_format?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: { name?: string; schema: Record<string, unknown> } };
  reasoning_effort?: 'low' | 'medium' | 'high';
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export function openAIToCanonical(req: OpenAIChatRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  let systemText: string | undefined;
  for (const m of req.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const t = extractText(m.content);
      if (t) systemText = (systemText ? systemText + '\n' : '') + t;
      continue;
    }
    if (m.role === 'user') {
      messages.push({ role: 'user', content: normalizeContent(m.content) });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: CanonicalContentBlock[] = [];
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
      else if (Array.isArray(m.content)) {
        for (const c of m.content as Array<{ type: string; text?: string; image_url?: { url: string } }>) {
          if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text });
          else if (c.type === 'image_url' && c.image_url) blocks.push({ type: 'image', image: { url: c.image_url.url } });
        }
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          blocks.push({ type: 'tool_use', toolUse: { id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) } });
        }
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolResult: { toolUseId: m.tool_call_id ?? 'unknown', content },
          },
        ],
      });
    }
  }
  const tools: CanonicalTool[] | undefined = req.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));
  let responseFormat: CanonicalRequest['responseFormat'];
  if (req.response_format) {
    if (req.response_format.type === 'json_schema' && req.response_format.json_schema) {
      responseFormat = { type: 'json_schema', jsonSchema: req.response_format.json_schema.schema };
    } else if (req.response_format.type === 'json_object') {
      responseFormat = { type: 'json_object' };
    } else {
      responseFormat = { type: 'text' };
    }
  }
  return {
    model: req.model,
    messages,
    system: systemText,
    tools,
    temperature: req.temperature,
    topP: req.top_p,
    maxOutputTokens: req.max_tokens,
    stop: Array.isArray(req.stop) ? req.stop : req.stop ? [req.stop] : undefined,
    stream: Boolean(req.stream),
    responseFormat,
    reasoning: req.reasoning_effort ? { effort: req.reasoning_effort } : undefined,
  };
}

export function canonicalToOpenAIRequest(req: CanonicalRequest, targetModel: string): OpenAIChatRequest {
  const out: OpenAIChatRequest = {
    model: targetModel,
    stream: req.stream,
    messages: [],
  };
  if (req.system) out.messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (m.content.every((b) => b.type === 'text')) {
        out.messages.push({ role: 'user', content: text });
      } else {
        const blocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        for (const b of m.content) {
          if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
          if (b.type === 'image' && b.image?.url) blocks.push({ type: 'image_url', image_url: { url: b.image.url } });
          if (b.type === 'image' && b.image?.base64) blocks.push({ type: 'image_url', image_url: { url: `data:${b.image.mimeType ?? 'image/png'};base64,${b.image.base64}` } });
        }
        out.messages.push({ role: 'user', content: blocks });
      }
    } else if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const toolCalls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.toolUse!.id,
        type: 'function' as const,
        function: { name: b.toolUse!.name, arguments: typeof b.toolUse!.input === 'string' ? b.toolUse!.input : JSON.stringify(b.toolUse!.input) },
      }));
      out.messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else if (m.role === 'tool') {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.messages.push({ role: 'tool', content: typeof b.toolResult!.content === 'string' ? b.toolResult!.content : JSON.stringify(b.toolResult!.content), tool_call_id: b.toolResult!.toolUseId });
        }
      }
    }
  }
  if (req.tools) out.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.maxOutputTokens !== undefined) out.max_tokens = req.maxOutputTokens;
  if (req.stop) out.stop = req.stop;
  if (req.responseFormat) {
    if (req.responseFormat.type === 'json_schema' && req.responseFormat.jsonSchema) {
      out.response_format = { type: 'json_schema', json_schema: { schema: req.responseFormat.jsonSchema } };
    } else if (req.responseFormat.type === 'json_object') {
      out.response_format = { type: 'json_object' };
    } else {
      out.response_format = { type: 'text' };
    }
  }
  if (req.reasoning?.effort) out.reasoning_effort = req.reasoning.effort;
  return out;
}

export function openAIResponseToCanonical(res: OpenAIChatResponse, requestedModel: string): { model: string; text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; finishReason: string | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number } } {
  const choice = res.choices[0];
  if (!choice || !choice.message) {
    // Handle empty or malformed response
    return {
      model: requestedModel,
      text: '',
      toolCalls: [],
      finishReason: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    };
  }

  return {
    model: requestedModel,
    text: typeof choice.message.content === 'string' ? choice.message.content : '',
    toolCalls: ((choice.message.tool_calls ?? []) as Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>).map((tc) => ({
      id: typeof tc.id === 'string' ? tc.id : `toolu-${Math.random().toString(36).slice(2)}`,
      name: typeof tc.function?.name === 'string' ? tc.function.name : 'unknown',
      input: safeJson(typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}'),
    })),
    finishReason: choice?.finish_reason ?? null,
    usage: {
      input: typeof res.usage?.prompt_tokens === 'number' ? res.usage.prompt_tokens : 0,
      output: typeof res.usage?.completion_tokens === 'number' ? res.usage.completion_tokens : 0,
      cacheRead: typeof res.usage?.prompt_tokens_details?.cached_tokens === 'number' ? res.usage.prompt_tokens_details.cached_tokens : 0,
      cacheWrite: 0,
      reasoning: typeof res.usage?.completion_tokens_details?.reasoning_tokens === 'number' ? res.usage.completion_tokens_details.reasoning_tokens : 0,
      total: typeof res.usage?.total_tokens === 'number' ? res.usage.total_tokens : 0,
    },
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');
  }
  return '';
}

function normalizeContent(content: unknown): CanonicalContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    const out: CanonicalContentBlock[] = [];
    for (const b of content as Array<{ type: string; text?: string; image_url?: { url: string } }>) {
      if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
      if (b.type === 'image_url' && b.image_url) out.push({ type: 'image', image: { url: b.image_url.url } });
    }
    return out;
  }
  throw new GatewayError('invalid_request_error', 'Unsupported message content', { status: 400 });
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// OpenAI model list
export function openAIModelList(models: Array<{ publicModelId: string; upstreamModelId: string }>) {
  return { object: 'list', data: models.map((m) => ({ id: m.publicModelId, object: 'model', created: 0, owned_by: m.publicModelId.split('/')[0] })) };
}
