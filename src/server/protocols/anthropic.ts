// Anthropic <-> canonical protocol layer.

import type { CanonicalRequest, CanonicalMessage, CanonicalContentBlock, CanonicalTool } from '../routing/capabilities';

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string }; id?: string; name?: string; input?: unknown; content?: unknown | string; tool_use_id?: string; is_error?: boolean }>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  metadata?: { user_id?: string };
  thinking?: { type: 'enabled'; budget_tokens: number };
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function anthropicToCanonical(req: AnthropicRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: parseAnthropicUserContent(m.content) });
    } else if (m.role === 'assistant') {
      const blocks: CanonicalContentBlock[] = [];
      const arr = Array.isArray(m.content) ? m.content : null;
      if (arr) {
        for (const b of arr) {
          if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
          if (b.type === 'tool_use' && b.id && b.name) blocks.push({ type: 'tool_use', toolUse: { id: b.id, name: b.name, input: b.input ?? {} } });
        }
      } else {
        blocks.push({ type: 'text', text: String(m.content) });
      }
      messages.push({ role: 'assistant', content: blocks });
    }
  }
  const tools: CanonicalTool[] | undefined = req.tools?.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
  let system: string | undefined;
  if (typeof req.system === 'string') system = req.system;
  else if (Array.isArray(req.system)) system = req.system.map((b) => b.text).join('\n');
  return {
    model: req.model,
    messages,
    system,
    tools,
    temperature: req.temperature,
    topP: req.top_p,
    maxOutputTokens: req.max_tokens,
    stop: req.stop_sequences,
    stream: Boolean(req.stream),
    reasoning: req.thinking ? { budgetTokens: req.thinking.budget_tokens } : undefined,
  };
}

function parseAnthropicUserContent(content: AnthropicMessage['content']): CanonicalContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: CanonicalContentBlock[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
    if (b.type === 'image' && b.source) {
      if (b.source.type === 'base64') {
        out.push({ type: 'image', image: { base64: b.source.data, mimeType: b.source.media_type } });
      } else if (b.source.type === 'url') {
        out.push({ type: 'image', image: { url: b.source.data } });
      }
    }
    if (b.type === 'tool_result') {
      out.push({
        type: 'tool_result',
        toolResult: {
          toolUseId: b.tool_use_id ?? '',
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null),
          isError: b.is_error,
        },
      });
    }
  }
  return out;
}

export function canonicalToAnthropicRequest(req: CanonicalRequest, targetModel: string): AnthropicRequest {
  const messages: AnthropicMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      const allText = m.content.every((b) => b.type === 'text');
      if (allText) {
        messages.push({ role: 'user', content: m.content.map((b) => b.text ?? '').join('') });
      } else {
        const blocks: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string }; tool_use_id?: string; content?: unknown; is_error?: boolean }> = [];
        for (const b of m.content) {
          if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
          if (b.type === 'image' && b.image?.base64) blocks.push({ type: 'image', source: { type: 'base64', media_type: b.image.mimeType ?? 'image/png', data: b.image.base64 } });
          if (b.type === 'image' && b.image?.url) blocks.push({ type: 'image', source: { type: 'url', media_type: 'image/png', data: b.image.url } });
          if (b.type === 'tool_result') blocks.push({ type: 'tool_result', tool_use_id: b.toolResult!.toolUseId, content: b.toolResult!.content, is_error: b.toolResult!.isError });
        }
        messages.push({ role: 'user', content: blocks as never });
      }
    } else if (m.role === 'assistant') {
      const blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
        if (b.type === 'tool_use' && b.toolUse) blocks.push({ type: 'tool_use', id: b.toolUse.id, name: b.toolUse.name, input: b.toolUse.input });
      }
      messages.push({ role: 'assistant', content: blocks as never });
    }
    // role 'tool' is mapped into user with tool_result in Anthropic — already done above
  }
  const out: AnthropicRequest = {
    model: targetModel,
    messages,
    stream: req.stream,
    max_tokens: req.maxOutputTokens ?? 1024,
  };
  if (req.system) out.system = req.system;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.stop) out.stop_sequences = req.stop;
  if (req.tools) out.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  if (req.reasoning?.budgetTokens) out.thinking = { type: 'enabled', budget_tokens: req.reasoning.budgetTokens };
  return out;
}

export function anthropicResponseToCanonical(res: AnthropicResponse, requestedModel: string) {
  const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('');
  const toolCalls = res.content.filter((b) => b.type === 'tool_use').map((b) => {
    const t = b as { type: 'tool_use'; id: string; name: string; input: unknown };
    return { id: t.id, name: t.name, input: t.input };
  });
  return {
    model: requestedModel,
    text,
    toolCalls,
    finishReason: res.stop_reason ?? null,
    usage: {
      input: res.usage.input_tokens ?? 0,
      output: res.usage.output_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      reasoning: 0,
      total: (res.usage.input_tokens ?? 0) + (res.usage.output_tokens ?? 0),
    },
  };
}

export function anthropicModelList(models: Array<{ publicModelId: string; upstreamModelId: string }>) {
  return {
    data: models.map((m) => ({ type: 'model', id: m.publicModelId, display_name: m.upstreamModelId })),
    first_id: models[0]?.publicModelId ?? null,
    has_more: false,
  };
}
