/** Limit a pending SSE frame (wire bytes, including its line delimiters) to 1 MiB. */
export const MAX_SSE_FRAME_BYTES = 1024 * 1024;

export interface SseEvent {
  data: string;
  event: string;
}

export class SseFrameError extends Error {
  constructor(readonly stage: 'sse_frame_limit' | 'invalid_sse_utf8' | 'truncated_stream', message: string) {
    super(message);
    this.name = 'SseFrameError';
  }
}

/** Incremental SSE parser. Only blank-line-terminated events are dispatched. */
export class SseParser {
  // Preserve BOMs in data; remove just the optional BOM at the start of the stream.
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private firstLine = true;
  private skipLf = false;
  private frameBytes = 0;
  private line = '';
  private data: string[] = [];
  private event = '';

  *push(bytes: Uint8Array): IterableIterator<SseEvent> {
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (this.skipLf) {
        this.skipLf = false;
        if (byte === 10) {
          // CRLF is one delimiter even when split between network chunks.
          if (this.frameBytes) this.count(1);
          start = i + 1;
          continue;
        }
      }
      if (byte !== 10 && byte !== 13) continue;
      this.append(bytes.subarray(start, i));
      this.count(1);
      this.flushDecoder();
      this.skipLf = byte === 13;
      start = i + 1;
      const event = this.endLine();
      if (event) yield event;
    }
    this.append(bytes.subarray(start));
  }

  finish(): void {
    this.flushDecoder();
    // An event without a blank-line delimiter may be a truncated JSON fragment
    // or usage tail. Do not turn it into a valid final event at EOF.
    const pending = this.firstLine ? this.line.replace(/^\uFEFF/, '') : this.line;
    if (this.data.length || (pending.length > 0 && !pending.startsWith(':'))) {
      throw new SseFrameError('truncated_stream', 'Upstream ended with an incomplete SSE frame');
    }
  }

  private count(bytes: number): void {
    this.frameBytes += bytes;
    if (this.frameBytes > MAX_SSE_FRAME_BYTES) {
      throw new SseFrameError('sse_frame_limit', 'Upstream SSE frame exceeds 1 MiB');
    }
  }

  private append(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.count(bytes.length);
    try {
      this.line += this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new SseFrameError('invalid_sse_utf8', 'Upstream SSE contains invalid UTF-8');
    }
  }

  private flushDecoder(): void {
    try {
      this.line += this.decoder.decode();
    } catch {
      throw new SseFrameError('invalid_sse_utf8', 'Upstream SSE contains invalid UTF-8');
    }
  }

  private endLine(): SseEvent | undefined {
    const line = this.firstLine ? this.line.replace(/^\uFEFF/, '') : this.line;
    this.firstLine = false;
    this.line = '';
    if (line === '') {
      const data = this.data.join('\n');
      const event = this.event || 'message';
      this.frameBytes = 0;
      this.data = [];
      this.event = '';
      // Empty data frames and keepalives never reach the generation callback.
      return data ? { data, event } : undefined;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // SSE removes at most one leading ASCII space after the field separator.
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
  }
}
