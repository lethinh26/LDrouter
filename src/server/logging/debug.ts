// Request-lifecycle debug logging.
//
// All output goes to stdout/stderr so `docker logs` collects it (docs/13).
// Every line is prefixed with the requestId so the whole lifecycle of one
// request can be extracted with:
//   docker logs ldrouter 2>&1 | grep req_xxx
//
// Env flags (all default off; enabled per docs/13 §22):
//   DEBUG_HTTP       — incoming request + body summary + messages/tools structure
//   DEBUG_HTTP_BODY  — full sanitized JSON bodies (incoming + upstream)
//   DEBUG_UPSTREAM   — upstream fetch/response/error detail
//   DEBUG_STREAM     — SSE stream lifecycle (start/first chunks/end/error)
// LOG_LEVEL gates lifecycle INFO-level lines ([INCOMING]/[DONE]/errors) —
// they emit at debug, so set LOG_LEVEL=debug to see them.

import process from 'node:process';
import { redactValue } from '../security/redact';

export interface DebugFlags {
  http: boolean;
  httpBody: boolean;
  upstream: boolean;
  stream: boolean;
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

let flags: DebugFlags | null = null;

/** Debug flags are read once per process (docs/13 §22). */
export function getDebugFlags(): DebugFlags {
  if (!flags) {
    flags = {
      http: envFlag('DEBUG_HTTP'),
      httpBody: envFlag('DEBUG_HTTP_BODY'),
      upstream: envFlag('DEBUG_UPSTREAM'),
      stream: envFlag('DEBUG_STREAM'),
    };
  }
  return flags;
}

export function resetDebugFlagsForTests(): void {
  flags = null;
}

// --- Output -------------------------------------------------------------
// Direct console use (not pino) keeps the human-readable
// [timestamp] [req_xxx] [TAG] line format that docs/13 §23 asks for, and is
// trivially visible in `docker logs -f`. Errors go to stderr.

function emit(level: 'info' | 'warn' | 'error', requestId: string, tag: string, lines: string[]): void {
  const ts = new Date().toISOString();
  const stream = level === 'error' ? process.stderr : process.stdout;
  for (const body of lines) {
    const first = body.split('\n')[0] ?? '';
    const rest = body.split('\n').slice(1).join('\n');
    const head = `[${ts}] [${requestId}] [${tag}] ${first}`;
    stream.write(rest ? head + '\n' + rest + '\n' : head + '\n');
  }
}

/** Lifecycle INFO line — always on (gated by LOG_LEVEL=debug via pino parity, but kept unconditional so operators never lose the trail). */
export function lifecycle(requestId: string, tag: string, lines: string[]): void {
  emit('info', requestId, tag, lines);
}

export function debugHttp(requestId: string, tag: string, lines: string[]): void {
  if (getDebugFlags().http) emit('info', requestId, tag, lines);
}

export function debugBody(requestId: string, tag: string, lines: string[]): void {
  if (getDebugFlags().httpBody) emit('info', requestId, tag, lines);
}

export function debugUpstream(requestId: string, tag: string, lines: string[]): void {
  if (getDebugFlags().upstream) emit('info', requestId, tag, lines);
}

export function debugStream(requestId: string, tag: string, lines: string[]): void {
  if (getDebugFlags().stream) emit('info', requestId, tag, lines);
}

export function errorLine(requestId: string, tag: string, lines: string[]): void {
  emit('error', requestId, tag, lines);
}

/** Fatal process-level line (no requestId). */
export function fatal(tag: string, lines: string[]): void {
  emit('error', '-', tag, lines);
}

// --- Sanitization --------------------------------------------------------

/** Sanitize an arbitrary value for logging: deep-redact secrets. */
export function sanitize(value: unknown): unknown {
  return redactValue(value);
}

/** Sanitized JSON string; on circular/unserializable falls back to a marker. */
export function sanitizeJson(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    try {
      return JSON.stringify({ bodyLogError: 'unserializable' });
    } catch {
      return '{"bodyLogError":"unserializable"}';
    }
  }
}

/** Truncate a string to `max` chars, marking truncation (docs/13 §5). */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars, truncated)`;
}

// --- Body / message / tool summarizers (docs/13 §4–§7) -------------------

type AnyRecord = Record<string, unknown>;

export function summarizeBody(body: AnyRecord): string[] {
  const lines: string[] = [];
  const p = (k: string, v: unknown) => {
    lines.push(`${k}=${v === undefined ? 'undefined' : JSON.stringify(v)}`);
  };
  p('model', body['model']);
  p('stream', body['stream']);
  const keys = Object.keys(body);
  lines.push(`bodyKeys=[${keys.map((k) => JSON.stringify(k)).join(', ')}]`);
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : null;
  lines.push(`messages=${messages ? messages.length : 'undefined'}`);
  const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : null;
  if (tools) {
    lines.push(`toolsCount=${tools.length}`);
    lines.push(`serializedToolsSize=${safeSize(tools)}`);
  }
  p('max_tokens', body['max_tokens']);
  p('max_completion_tokens', body['max_completion_tokens']);
  p('temperature', body['temperature']);
  p('top_p', body['top_p']);
  p('reasoning_effort', body['reasoning_effort']);
  p('reasoning', body['reasoning']);
  p('thinking', body['thinking']);
  p('tool_choice', body['tool_choice']);
  p('parallel_tool_calls', body['parallel_tool_calls']);
  p('response_format', body['response_format']);
  p('stream_options', body['stream_options']);
  if (messages) {
    lines.push(`messageRoles=[${messages.map((m) => (isRec(m) ? String(m['role'] ?? '?') : '?')).join(',')}]`);
  }
  return lines;
}

export function summarizeMessages(body: AnyRecord): string[] {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  const lines: string[] = [];
  messages.forEach((m, i) => {
    if (!isRec(m)) {
      lines.push(`#${i} <non-object: ${typeof m}>`);
      return;
    }
    const role = m['role'];
    const content = m['content'];
    const contentDesc =
      content === null
        ? 'contentType=null contentLength=0'
        : typeof content === 'string'
          ? `contentType=string contentLength=${content.length}`
          : Array.isArray(content)
            ? `contentType=array contentParts=${content.length}`
            : content === undefined
              ? 'contentType=undefined'
              : `contentType=${typeof content}`;
    lines.push(`#${i} role=${role} ${contentDesc}`);
    const toolCalls = m['tool_calls'];
    if (Array.isArray(toolCalls)) lines.push(`  toolCalls=${toolCalls.length}`);
    if (m['tool_call_id']) lines.push(`  toolCallId=${String(m['tool_call_id'])}`);
    if ('reasoning_content' in m) lines.push(`  reasoningContent=present`);
    if (Array.isArray(content)) {
      const partTypes = content.map((c) => (isRec(c) ? String(c['type'] ?? '?') : '?')).join(',');
      lines.push(`  partTypes=[${partTypes}]`);
    }
  });
  return lines;
}

export function summarizeTools(body: AnyRecord): string[] {
  const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : [];
  const lines: string[] = [`count=${tools.length}`, `serializedSize=${safeSize(tools)}`];
  tools.forEach((t, i) => {
    if (!isRec(t)) {
      lines.push(`tool[${i}]: <non-object>`);
      return;
    }
    const fn = isRec(t['function']) ? t['function'] : null;
    const name = fn ? String(fn['name'] ?? '?') : String(t['name'] ?? '?');
    const descLen = fn && typeof fn['description'] === 'string' ? (fn['description'] as string).length : fn?.['description'] !== undefined ? -1 : 0;
    const schema = fn ? fn['parameters'] : t['input_schema'];
    const schemaSize = schema !== undefined ? safeSize(schema) : 0;
    lines.push(`tool[${i}]: name=${name} descriptionLength=${descLen} schemaSize=${schemaSize}`);
  });
  return lines;
}

// --- Error formatting (docs/13 §13) ---------------------------------------

/** Full error detail including nested undici `cause` chains. */
export function formatError(e: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let depth = 0;
  let cur: unknown = e;
  while (cur instanceof Error && depth < 4) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const prefix = depth === 0 ? '' : 'cause.';
    lines.push(`${prefix}name=${cur.name}`);
    lines.push(`${prefix}message=${cur.message}`);
    const code = (cur as { code?: string }).code;
    if (code) lines.push(`${prefix}code=${code}`);
    if (depth === 0 && cur.stack) lines.push(`stack=${truncate(cur.stack, 4000)}`);
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  if (cur !== undefined && cur !== null && !(cur instanceof Error)) {
    lines.push(`cause(raw)=${truncate(safeStringify(cur), 2000)}`);
  }
  if (lines.length === 0) lines.push(`value=${truncate(safeStringify(e), 2000)}`);
  return lines;
}

// --- Helpers --------------------------------------------------------------

function isRec(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return -1;
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

// --- Header sanitization (docs/13 §2–§3) ----------------------------------

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'x-goog-api-key',
  'proxy-authorization',
]);

const INTERESTING_HEADERS = [
  'content-type',
  'content-length',
  'user-agent',
  'host',
  'x-forwarded-for',
  'cf-ray',
  'cf-connecting-ip',
  'accept',
  'accept-encoding',
  'connection',
  'anthropic-version',
];

/** Sanitized incoming-request header lines for the [INCOMING] block. */
export function summarizeHeaders(headers: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const name of INTERESTING_HEADERS) {
    const v = headers[name];
    if (v !== undefined) lines.push(`${name}=${Array.isArray(v) ? v.join(',') : String(v)}`);
  }
  const auth = headers['authorization'];
  if (auth !== undefined) lines.push(`authorization=Bearer ***REDACTED***`);
  const apiKey = headers['x-api-key'];
  if (apiKey !== undefined) lines.push(`x-api-key=***REDACTED***`);
  // Report presence of any other sensitive headers without values.
  for (const k of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase()) && !lines.some((l) => l.startsWith(`${k.toLowerCase()}=`) || l.startsWith(`${k}=`))) {
      lines.push(`${k}=***REDACTED***`);
    }
  }
  return lines;
}
