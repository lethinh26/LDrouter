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

/** Any reason a routing candidate can be excluded. The direct-model path and
 *  the combo path share this one vocabulary so a client can never get two
 *  different stories for the same problem. */
export type RejectionReason =
  | 'model_not_found'
  | 'provider_not_found'
  | 'provider_disabled'
  | 'model_disabled'
  | 'upstream_unavailable'
  | 'circuit_open'
  | 'combo_disabled'
  | 'member_disabled'
  | 'codex_account_unavailable'
  | 'streaming'
  | 'tools'
  | 'structured_output'
  | 'image_input'
  | 'audio_input'
  | 'responses';

/**
 * The single table of "explicitly unsupported" checks. `modelMeets` and the
 * rejection reporter both read it, so they can never disagree about a model.
 * `reasoning` is deliberately absent: it is advisory metadata, because an
 * upstream may support reasoning even when discovery cannot identify it.
 */
const CAPABILITY_CHECKS: Array<{
  flag: keyof ModelCapabilitiesInput;
  required: keyof RequiredCapabilities;
  reason: RejectionReason;
  label: string;
}> = [
  { flag: 'streaming', required: 'streaming', reason: 'streaming', label: 'no streaming' },
  { flag: 'tools', required: 'tools', reason: 'tools', label: 'no tool calling' },
  { flag: 'structured_output', required: 'structuredOutput', reason: 'structured_output', label: 'no structured output' },
  { flag: 'image_input', required: 'imageInput', reason: 'image_input', label: 'no image input' },
  { flag: 'audio_input', required: 'audioInput', reason: 'audio_input', label: 'no audio input' },
  { flag: 'responses', required: 'responses', reason: 'responses', label: 'no Responses API support' },
];

const NON_CAPABILITY_TEXT: Partial<Record<RejectionReason, string>> = {
  model_not_found: 'model not found',
  provider_not_found: 'provider not found',
  provider_disabled: 'provider disabled',
  model_disabled: 'model disabled',
  upstream_unavailable: 'not available upstream',
  circuit_open: 'provider circuit is open',
  combo_disabled: 'combo disabled',
  member_disabled: 'disabled in this combo',
  codex_account_unavailable: 'no available Codex account',
};

const REASON_TEXT: Record<RejectionReason, string> = {
  ...(NON_CAPABILITY_TEXT as Record<RejectionReason, string>),
  ...Object.fromEntries(CAPABILITY_CHECKS.map((c) => [c.reason, c.label])) as Record<RejectionReason, string>,
};

const CAPABILITY_REASONS = new Set<string>(CAPABILITY_CHECKS.map((c) => c.reason));

/**
 * Check if a model meets required capabilities.
 * IMPORTANT: Treat undefined as "unknown" rather than "unsupported".
 * For generic OpenAI-compatible providers where capabilities weren't explicitly imported,
 * undefined means we don't know, so we should assume it's potentially supported.
 * Explicit false means "known unsupported" for protocol capabilities such as
 * tools, images, and streaming. Reasoning is advisory metadata because the
 * upstream may support it even when discovery cannot identify it.
 */
export function modelMeets(caps: ModelCapabilitiesInput, req: RequiredCapabilities): boolean {
  return firstMissingCapability(caps, req) === null;
}

/** The first capability this model is KNOWN not to support (undefined = unknown
 *  caps never reject), or null when nothing required is explicitly missing. */
export function firstMissingCapability(caps: ModelCapabilitiesInput, req: RequiredCapabilities): RejectionReason | null {
  for (const c of CAPABILITY_CHECKS) {
    if (req[c.required] && caps[c.flag] === false) return c.reason;
  }
  return null;
}

/**
 * `vl/gpt-5.5` is reported to clients as `gpt-5.5`: the provider prefix is the
 * gateway's bookkeeping, not the operator's or the API client's vocabulary.
 */
export function bareModelName(publicModelId: string): string {
  const i = publicModelId.indexOf('/');
  return i === -1 ? publicModelId : publicModelId.slice(i + 1);
}

export interface RejectedMember {
  publicModelId: string;
  reason: RejectionReason;
}

export interface RejectionSummary {
  message: string;
  type: 'capability_not_supported' | 'upstream_unavailable';
  status: number;
}

/**
 * Turn per-model rejection reasons into one client-facing error that names every
 * excluded model and why. The old blanket strings ("No combo member satisfies
 * the request capabilities or availability", "No available model candidates")
 * told the caller nothing it could act on — docs/13 §10 records that as a bug.
 *
 * A capability miss is deterministic, so it wins the status code (400); reasons
 * of mere *availability* are still listed so nothing is hidden. When no
 * capability was involved the targetis simply unavailable (502).
 */
export function describeRejections(
  target: { kind: 'model' | 'combo'; publicModelId: string },
  rejected: RejectedMember[]
): RejectionSummary {
  const groups = new Map<string, string[]>();
  for (const r of rejected) {
    const label = REASON_TEXT[r.reason] ?? r.reason;
    groups.set(label, [...(groups.get(label) ?? []), bareModelName(r.publicModelId)]);
  }
  // A direct model is also the target, so naming it twice would only be noise.
  const detail =
    target.kind === 'model'
      ? [...groups.keys()].join('; ')
      : [...groups].map(([label, names]) => `${[...new Set(names)].join(', ')} (${label})`).join('; ');
  const subject = target.kind === 'combo' ? `Combo "${target.publicModelId}"` : `Model "${bareModelName(target.publicModelId)}"`;
  const message = `${subject} cannot serve this request: ${detail || 'no usable member'}`;
  return rejected.some((r) => CAPABILITY_REASONS.has(r.reason))
    ? { message, type: 'capability_not_supported', status: 400 }
    : { message, type: 'upstream_unavailable', status: 502 };
}
