// Derive capability requirements from a canonical request.

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';
export interface CanonicalContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'audio' | 'document';
  text?: string;
  image?: { url?: string; base64?: string; mimeType?: string };
  audio?: { url?: string; base64?: string; mimeType?: string };
  toolUse?: { id: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: string | unknown[]; isError?: boolean };
  document?: { url?: string; base64?: string; mimeType?: string; name?: string };
}
export interface CanonicalMessage {
  role: CanonicalRole;
  content: CanonicalContentBlock[];
}
export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  system?: string;
  tools?: CanonicalTool[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
  stream: boolean;
  responseFormat?: { type: 'text' | 'json_object' | 'json_schema'; jsonSchema?: Record<string, unknown> };
  reasoning?: { effort?: 'low' | 'medium' | 'high'; budgetTokens?: number };
  metadata?: Record<string, string>;
}

export interface RequiredCapabilities {
  streaming: boolean;
  tools: boolean;
  structuredOutput: boolean;
  imageInput: boolean;
  audioInput: boolean;
  reasoning: boolean;
  responses: boolean;
}

export function deriveRequiredCapabilities(req: CanonicalRequest): RequiredCapabilities {
  let tools = false;
  let imageInput = false;
  let audioInput = false;
  for (const m of req.messages) {
    for (const b of m.content ?? []) {
      if (b.type === 'image') imageInput = true;
      if (b.type === 'audio') audioInput = true;
    }
  }
  if (req.tools && req.tools.length > 0) tools = true;
  // tool_use/tool_result blocks imply tool calling
  for (const m of req.messages) {
    for (const b of m.content ?? []) {
      if (b.type === 'tool_use' || b.type === 'tool_result') tools = true;
    }
  }
  let structuredOutput = false;
  if (req.responseFormat && (req.responseFormat.type === 'json_object' || req.responseFormat.type === 'json_schema')) structuredOutput = true;
  return {
    streaming: Boolean(req.stream),
    tools,
    structuredOutput,
    imageInput,
    audioInput,
    reasoning: Boolean(req.reasoning),
    responses: false,
  };
}

export interface ModelCapabilitiesInput {
  chat?: boolean;
  responses?: boolean;
  streaming?: boolean;
  tools?: boolean;
  structured_output?: boolean;
  image_input?: boolean;
  audio_input?: boolean;
  reasoning?: boolean;
}

export function modelMeets(caps: ModelCapabilitiesInput, req: RequiredCapabilities): boolean {
  if (req.streaming && !caps.streaming) return false;
  if (req.tools && !caps.tools) return false;
  if (req.structuredOutput && !caps.structured_output) return false;
  if (req.imageInput && !caps.image_input) return false;
  if (req.audioInput && !caps.audio_input) return false;
  if (req.reasoning && !caps.reasoning) return false;
  if (req.responses && !caps.responses) return false;
  return true;
}
