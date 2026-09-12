import { createHash } from 'node:crypto';

const MAX_INPUT_BYTES = 2_000_000;
const MAX_RECORDS = 500;
const MAX_TOKEN_LENGTH = 200_000;
const FALLBACK_TTL_MS = 10 * 24 * 60 * 60 * 1000;

type JsonObject = Record<string, unknown>;

export interface ParseFailure {
  index: number;
  source?: string;
  error: string;
}

export interface NormalizedCodexRecord {
  index: number;
  email: string | null;
  workspaceId: string | null;
  chatgptAccountId: string | null;
  planType: string | null;
  expiresAt: string;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  identity: string;
  source?: string;
}

export interface CodexPreviewRecord {
  index: number;
  source?: string;
  valid: true;
  email: string | null;
  accountIdMasked: string | null;
  workspaceIdMasked: string | null;
  planType: string | null;
  expiresAt: string;
  duplicateOf: string | null;
}

export interface CodexImportResult {
  records: CodexPreviewRecord[];
  failures: Array<{ index: number; source?: string; error: 'Invalid record' }>;
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

function decodeJwt(token: string): JsonObject {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const text = Buffer.from(part, 'base64url').toString('utf8');
    return objectValue(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

function parseExpiry(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const text = stringValue(value);
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(text) && text.length < 14) return parseExpiry(numeric);
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function relativeExpiry(value: unknown, now: Date): string | null {
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const timestamp = now.getTime() + numeric * 1000;
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mask(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function stableIdentity(workspaceId: string | null, accountId: string | null, accessToken: string): string {
  if (accountId) return `account:${accountId}`;
  if (workspaceId) return `workspace:${workspaceId}`;
  return `token:${createHash('sha256').update(accessToken).digest('hex')}`;
}

export function normalizeCodexRecord(input: unknown, index: number, now = new Date(), source?: string): NormalizedCodexRecord | ParseFailure {
  const raw = objectValue(input);
  if (!raw) return { index, source, error: 'Record must be a JSON object' };
  const tokens = objectValue(raw.tokens);
  const accessToken = firstString(raw.access_token, raw.accessToken, tokens?.access_token, tokens?.accessToken);
  const refreshToken = firstString(raw.refresh_token, raw.refreshToken, tokens?.refresh_token, tokens?.refreshToken);
  const idToken = firstString(raw.id_token, raw.idToken, tokens?.id_token, tokens?.idToken);
  if (!accessToken) return { index, source, error: 'Missing access token' };
  if (!refreshToken) return { index, source, error: 'Missing refresh token' };
  if (accessToken.length > MAX_TOKEN_LENGTH || refreshToken.length > MAX_TOKEN_LENGTH || (idToken?.length ?? 0) > MAX_TOKEN_LENGTH) return { index, source, error: 'Token exceeds maximum length' };

  const accessClaims = decodeJwt(accessToken);
  const idClaims = idToken ? decodeJwt(idToken) : {};
  const accessAuth = objectValue(accessClaims['https://api.openai.com/auth']) ?? {};
  const idAuth = objectValue(idClaims['https://api.openai.com/auth']) ?? {};
  const accessProfile = objectValue(accessClaims['https://api.openai.com/profile']) ?? {};
  const idProfile = objectValue(idClaims['https://api.openai.com/profile']) ?? {};
  const auth = { ...idAuth, ...accessAuth };
  const profile = { ...idProfile, ...accessProfile };
  const email = firstString(profile.email, accessClaims.email, idClaims.email, raw.email);
  const chatgptAccountId = firstString(auth.chatgpt_account_id, auth.account_id, raw.chatgpt_account_id, raw.chatgptAccountId, raw.account_id, raw.accountId);
  const workspaceId = firstString(raw.workspace_id, raw.workspaceId, raw.organization_id, raw.organizationId, auth.workspace_id, auth.workspaceId);
  const planType = firstString(auth.chatgpt_plan_type, auth.plan_type, raw.chatgpt_plan_type, raw.plan_type, raw.planType);

  const explicitExpiryKey = ['expired', 'expires_at', 'expiresAt'].find((key) => Object.prototype.hasOwnProperty.call(raw, key));
  const expiresAt = explicitExpiryKey
    ? parseExpiry(raw[explicitExpiryKey])
    : parseExpiry(accessClaims.exp) ?? parseExpiry(idClaims.exp) ?? (raw.expires_in !== undefined ? relativeExpiry(raw.expires_in, now) : null);
  if (explicitExpiryKey && !expiresAt) return { index, source, error: 'Invalid explicit expiry' };
  if (!explicitExpiryKey && raw.expires_in !== undefined && !expiresAt) return { index, source, error: 'Invalid relative expiry' };
  const resolvedExpiresAt = expiresAt ?? new Date(now.getTime() + FALLBACK_TTL_MS).toISOString();
  return { index, source, email, workspaceId, chatgptAccountId, planType, expiresAt: resolvedExpiresAt, accessToken, refreshToken, idToken, identity: stableIdentity(workspaceId, chatgptAccountId, accessToken) };
}

function expandRoot(value: unknown): unknown[] {
  const root = objectValue(value);
  if (Array.isArray(value)) return value;
  if (root && Array.isArray(root.accounts)) return root.accounts;
  return [value];
}

export function parseCodexImportText(text: string, source?: string, now = new Date()): Array<NormalizedCodexRecord | ParseFailure> {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) return [{ index: 0, source, error: 'Input exceeds maximum size' }];
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [{ index: 0, source, error: 'Input is empty' }];
  let roots: unknown[];
  try {
    roots = expandRoot(JSON.parse(cleaned) as unknown);
  } catch {
    const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length <= 1) return [{ index: 0, source, error: 'Malformed JSON input' }];
    roots = lines.map((line) => { try { return JSON.parse(line) as unknown; } catch { return Symbol('malformed'); } });
  }
  const results: Array<NormalizedCodexRecord | ParseFailure> = [];
  for (const root of roots) {
    for (const item of expandRoot(root)) {
      if (results.length >= MAX_RECORDS) {
        results.push({ index: results.length, source, error: 'Input exceeds maximum record count' });
        return results;
      }
      results.push(normalizeCodexRecord(item, results.length, now, source));
    }
  }
  return results;
}

export function toCodexPreview(record: NormalizedCodexRecord, duplicateOf: string | null = null): CodexPreviewRecord {
  return { index: record.index, source: record.source, valid: true, email: record.email, accountIdMasked: mask(record.chatgptAccountId), workspaceIdMasked: mask(record.workspaceId), planType: record.planType, expiresAt: record.expiresAt, duplicateOf };
}

export function toCodexImportResult(records: NormalizedCodexRecord[], failures: ParseFailure[] = []): CodexImportResult {
  return { records: records.map((record) => toCodexPreview(record)), failures: failures.map(({ index, source }) => ({ index, source, error: 'Invalid record' })) };
}
