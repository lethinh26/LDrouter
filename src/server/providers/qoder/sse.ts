// Unwrap Qoder's `data: {"statusCodeValue":N,"body":"<openai chunk json>"}` SSE envelope
// into plain OpenAI chunks, and coalesce the terminal state.
//
// Two upstream quirks drive this design:
//   1. finish_reason arrives on `delta`, usage arrives later on a `choices: []` frame.
//      Downstream clients only read usage from the finish chunk, so both are held and
//      emitted as one terminal chunk.
//   2. Qoder keeps the socket open after the terminal frame (agent keepalive).
//      terminal() tells the caller to stop reading and close immediately.
export interface QoderUsage { input: number; output: number; total: number; cacheRead: number; cacheWrite: number; reasoning: number }

export interface QoderErrorEnvelope { statusValue: number; message: string; billing: boolean }

const BILLING_CODES = /"code"\s*:\s*"(112|10605)"/;

function isBilling(message: string): boolean {
  return BILLING_CODES.test(message) || message.toLowerCase().includes('pricingurl');
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function qoderUsageOf(value: unknown): QoderUsage {
  const usage = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  // The envelope nests the real OpenAI usage object one level down under `body`, so a
  // few shapes are worth reading; the flat one stays authoritative when present.
  const nested = (usage.usage && typeof usage.usage === 'object' ? usage.usage : {}) as Record<string, unknown>;
  const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const details = asObject(usage.prompt_tokens_details ?? nested.prompt_tokens_details);
  const input = numberOr(usage.prompt_tokens ?? usage.input_tokens ?? nested.prompt_tokens ?? nested.input_tokens, 0);
  const output = numberOr(usage.completion_tokens ?? usage.output_tokens ?? nested.completion_tokens ?? nested.output_tokens, 0);
  return {
    input, output,
    total: numberOr(usage.total_tokens ?? nested.total_tokens, input + output),
    cacheRead: numberOr(
      details.cached_tokens ?? usage.cached_tokens ?? usage.cache_read_input_tokens
        ?? nested.cached_tokens,
      0,
    ),
    cacheWrite: numberOr(details.cache_creation_tokens ?? usage.cache_creation_input_tokens, 0),
    reasoning: numberOr(usage.reasoning_tokens ?? (usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens, 0),
  };
}

interface PendingToolCall { id?: string; function?: { name?: string; arguments?: string } }

export class QoderEnvelopeReader {
  readonly chunks: string[] = [];
  readonly toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  text = '';
  finishReason: string | null = null;
  usage: QoderUsage | null = null;
  error: QoderErrorEnvelope | null = null;
  private buffer = '';
  // Non-`data:` lines, in arrival order: a plain (unframed) JSON body. See takeUnparsed().
  private plain: string[] = [];
  private ended = false;
  private pendingFinish: string | null = null;
  private pendingUsage: QoderUsage | null = null;
  private finishForwarded = false;
  private meta: { id: string | null; created: number | null };

  constructor(private readonly options: { model: string }) {
    this.meta = { id: null, created: null };
  }

  terminal(): boolean { return this.ended; }
  errorEnvelope(): QoderErrorEnvelope | null { return this.error; }

  /**
   * Take the buffered, never-`data:`-framed bytes (if any) and clear them. An origin
   * answering a non-streaming call with a plain JSON completion leaves the whole
   * response here — the SSE line scanner only recognises `data:` frames.
   */
  takeUnparsed(): string {
    const raw = [...this.plain, this.buffer].join('\n').trim();
    this.plain = [];
    this.buffer = '';
    return raw;
  }

  /**
   * Fold an OpenAI-shaped non-streaming completion into this reader, so the caller
   * gets text/toolCalls/finishReason/usage from one accessor set regardless of how
   * the origin framed the answer. `usage` is only written when the body carries one:
   * a zero would be indistinguishable from "the provider reported nothing".
   */
  applyCompletion(body: Record<string, unknown>): void {
    const choice = (Array.isArray(body.choices) ? body.choices[0] : null) as Record<string, unknown> | null;
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    if (typeof message.content === 'string') this.text += message.content;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls as PendingToolCall[] : [];
    for (const call of calls) {
      let input: unknown = {};
      if (typeof call.function?.arguments === 'string' && call.function.arguments) {
        try { input = JSON.parse(call.function.arguments) as unknown; } catch { input = {}; }
      }
      this.toolCalls.push({ id: call.id ?? `call-${this.toolCalls.length}`, name: call.function?.name ?? 'unknown', input });
    }
    // Assigned directly, not via the pending machinery: this body is complete, and the
    // stream has already ended (finish() set `ended`), which those paths return early on.
    const finish = (choice?.finish_reason ?? (typeof body.status === 'string' ? body.status : null)) as string | null;
    if (finish) this.finishReason = finish;
    if (body.usage) this.usage = qoderUsageOf(body.usage);
    this.ended = true;
  }

  push(text: string): void {
    if (this.ended) return;
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.line(line);
      if (this.ended) return;
    }
  }

  /** Flush a final line that arrived without a terminating newline. */
  finish(): void {
    if (!this.ended && this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = '';
      this.line(line);
    }
    this.flushPending();
  }

  cancel(): void { this.ended = true; this.buffer = ''; }

  private line(raw: string): void {
    // trim() also drops the trailing CR of a CRLF frame, so no separate strip is needed.
    const trimmed = raw.trim();
    if (!trimmed.startsWith('data:')) {
      // An origin answering a non-streaming call may send the whole completion as one
      // plain JSON body instead of SSE frames. Hold those lines rather than dropping
      // them: finish() consumes the buffer, so this is the only place they survive.
      // Blank lines and `:comment` keepalives are not content.
      if (trimmed && !trimmed.startsWith(':')) this.plain.push(trimmed);
      return;
    }
    const data = trimmed.slice(5).trimStart();
    if (data === '[DONE]') { this.flushPending(); return; }

    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(data) as Record<string, unknown>; } catch { return; }

    const statusValue = numberOr(envelope.statusCodeValue, 200);
    let inner: string;
    if (typeof envelope.body === 'string') {
      inner = envelope.body;
      // Upstream may send `body` as a JSON-encoded string literal; unwrap that one layer.
      if (inner.startsWith('"')) {
        try { const parsed = JSON.parse(inner) as unknown; if (typeof parsed === 'string') inner = parsed; } catch { /* keep raw */ }
      }
    } else {
      inner = envelope.body == null ? '' : JSON.stringify(envelope.body);
    }

    if (statusValue !== 200) {
      this.error = { statusValue, message: inner || `upstream status ${statusValue}`, billing: isBilling(inner) };
      this.ended = true;
      return;
    }
    if (!inner || inner === '[DONE]') { this.flushPending(); return; }

    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(inner) as Record<string, unknown>; } catch { return; }

    if (typeof chunk.id === 'string' && chunk.id) this.meta.id = chunk.id;
    if (typeof chunk.created === 'number') this.meta.created = chunk.created;
    if (chunk.usage) this.pendingUsage = qoderUsageOf(chunk.usage);

    const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : null) as Record<string, unknown> | null;
    const delta = (choice?.delta ?? {}) as Record<string, unknown>;
    const finish = (choice?.finish_reason ?? delta.finish_reason) as string | null | undefined;
    const content = typeof delta.content === 'string' ? delta.content : '';
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls as PendingToolCall[] : [];

    if (content || reasoning || toolCalls.length > 0) {
      if (content) this.text += content;
      for (const call of toolCalls) {
        let input: unknown = {};
        if (typeof call.function?.arguments === 'string' && call.function.arguments) {
          try { input = JSON.parse(call.function.arguments) as unknown; } catch { input = {}; }
        }
        this.toolCalls.push({ id: call.id ?? `call-${this.toolCalls.length}`, name: call.function?.name ?? 'unknown', input });
      }
      // Pass the upstream chunk through verbatim so client-side shape is preserved.
      this.emit(chunk);
      // Forward the upstream finish reason verbatim; a `tool_calls` finish must survive
      // the coalesce, so never coerce it to 'stop' here.
      if (finish) { this.finishForwarded = true; this.pendingFinish = finish; this.finishReason = finish; }
      this.endOnUsage();
      return;
    }

    if (finish) { this.pendingFinish = finish; this.finishReason = finish; }
    this.endOnUsage();
  }

  /**
   * A usage frame terminates the stream even when no finish_reason was ever seen: usage
   * arriving is itself the end-of-stream signal. Shared by both entry paths so they cannot
   * drift apart. When both are present the coalesce still happens in emitTerminal().
   */
  private endOnUsage(): void {
    if (!this.pendingUsage) return;
    if (!this.pendingFinish) this.pendingFinish = 'stop';
    this.emitTerminal();
  }

  private emit(chunk: Record<string, unknown>): void {
    this.chunks.push(JSON.stringify(chunk));
  }

  private emitTerminal(): void {
    if (this.pendingFinish || this.pendingUsage) {
      // We only reach here with finishReason still null when we synthesized 'stop' ourselves
      // (usage-only termination). The accessor must report what went on the wire; a real
      // upstream reason is always recorded alongside pendingFinish and is never overwritten.
      if (!this.finishReason) this.finishReason = 'stop';
      this.usage = this.pendingUsage ?? this.usage;
      this.chunks.push(JSON.stringify({
        id: this.meta.id ?? `qoder-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: this.meta.created ?? Math.floor(Date.now() / 1000),
        model: this.options.model,
        choices: [{ index: 0, delta: {}, finish_reason: this.pendingFinish ?? 'stop' }],
        ...(this.pendingUsage ? { usage: this.toOpenAIUsage(this.pendingUsage) } : {}),
      }));
      this.pendingFinish = null;
      this.pendingUsage = null;
    }
    this.ended = true;
  }

  private flushPending(): void {
    if (this.ended) return;
    if (this.pendingUsage || (this.pendingFinish && !this.finishForwarded)) this.emitTerminal();
    this.ended = true;
  }

  private toOpenAIUsage(usage: QoderUsage): Record<string, unknown> {
    return {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.total,
      ...(usage.cacheRead ? { prompt_tokens_details: { cached_tokens: usage.cacheRead } } : {}),
      ...(usage.reasoning ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
    };
  }
}
