// Qoder credential import normalizer. PAT-only: a `pt-…` personal access token is the single
// importable credential, because it is the only one the gateway can renew itself. Device tokens
// (`dt-…`) expire after ~30 days with no refresh and job tokens (`jt-…`) are derived and
// short-lived, so both are rejected here with a reason instead of failing upstream later.
import { createHash } from 'node:crypto';

const MAX_INPUT_BYTES = 2_000_000;
const MAX_RECORDS = 500;
const MAX_TOKEN_LENGTH = 200_000;
const PAT_PREFIX = 'pt-';

type JsonObject = Record<string, unknown>;

export interface QoderParseFailure {
  index: number;
  source?: string;
  error: string;
}

export interface NormalizedQoderToken {
  index: number;
  personalToken: string;
  label: string | null;
  source?: string;
}

export interface QoderPreviewRecord {
  index: number;
  source?: string;
  valid: true;
  personalTokenMasked: string;
  label: string | null;
  /** Stable per-token identity, so a re-import can be reported as an update rather than an add. */
  fingerprint: string;
  duplicateOf: string | null;
  error?: undefined;
}

export interface QoderImportResult {
  records: QoderPreviewRecord[];
  failures: Array<{ index: number; source?: string; error: string }>;
}

const stringValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const result = value.replace(/^\uFEFF/, '').trim();
  return result || null;
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return null;
};

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function mask(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 8 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Never derived from the token itself in any recoverable way — one-way, like Codex's identity. */
export function qoderTokenFingerprint(personalToken: string): string {
  return `pat:${createHash('sha256').update(personalToken).digest('hex').slice(0, 32)}`;
}

export function isQoderPatImportable(token: unknown): boolean {
  return typeof token === 'string' && token.trim().startsWith(PAT_PREFIX);
}

export function normalizeQoderToken(input: unknown, index: number, source?: string): NormalizedQoderToken | QoderParseFailure {
  const raw = objectValue(input);
  // A bare string is the token; an object is matched against the aliases the Codex importer
  // accepts so one export file works for either provider.
  const token = stringValue(input) ?? (raw
    ? firstString(raw.token, raw.pt_token, raw.personal_token, raw.personalToken, raw.access_token, raw.accessToken)
    : null);
  if (!token) return { index, source, error: 'Missing personal access token' };
  if (token.length > MAX_TOKEN_LENGTH) return { index, source, error: 'Token exceeds maximum length' };
  if (!token.startsWith(PAT_PREFIX)) {
    // A dt- device token or a jt- job token is not importable; saying so beats an opaque 403 later.
    return { index, source, error: 'Not a Qoder personal access token (must start with pt-)' };
  }
  const label = raw ? firstString(raw.label, raw.name, raw.email) : null;
  return { index, personalToken: token, label, source };
}

function expandRoot(value: unknown): unknown[] {
  const root = objectValue(value);
  if (Array.isArray(value)) return value;
  if (root && Array.isArray(root.accounts)) return root.accounts;
  return [value];
}

export function parseQoderImportText(text: string, source?: string): Array<NormalizedQoderToken | QoderParseFailure> {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) return [{ index: 0, source, error: 'Input exceeds maximum size' }];
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [{ index: 0, source, error: 'Input is empty' }];

  let roots: unknown[];
  try {
    roots = expandRoot(JSON.parse(cleaned) as unknown);
  } catch {
    // Plain text / JSONL: one token (or JSON object) per line. A single unparseable line is
    // still passed through as a bare string so the pt- check reports the real reason.
    const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    roots = lines.map((line) => {
      try { return JSON.parse(line) as unknown; } catch { return line; }
    });
  }

  const results: Array<NormalizedQoderToken | QoderParseFailure> = [];
  for (const root of roots) {
    for (const item of expandRoot(root)) {
      if (results.length >= MAX_RECORDS) {
        results.push({ index: results.length, source, error: 'Input exceeds maximum record count' });
        return results;
      }
      results.push(normalizeQoderToken(item, results.length, source));
    }
  }
  return results;
}

export function toQoderPreview(record: NormalizedQoderToken, duplicateOf: string | null = null): QoderPreviewRecord {
  return {
    index: record.index, source: record.source, valid: true,
    personalTokenMasked: mask(record.personalToken) ?? '', label: record.label,
    fingerprint: qoderTokenFingerprint(record.personalToken), duplicateOf,
  };
}

export function toQoderImportResult(records: NormalizedQoderToken[], failures: QoderParseFailure[] = []): QoderImportResult {
  return { records: records.map((record) => toQoderPreview(record)), failures };
}
