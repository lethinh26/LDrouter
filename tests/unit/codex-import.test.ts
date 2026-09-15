import { describe, expect, it } from 'vitest';
import {
  normalizeCodexRecord,
  parseCodexImportText,
  toCodexPreview,
  type NormalizedCodexRecord,
} from '@server/providers/codex-import';

const access = 'access-secret-fixture';
const refresh = 'refresh-secret-fixture';
const id = 'id-secret-fixture';
const jwt = (payload: Record<string, unknown>) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    access_token: access,
    refresh_token: refresh,
    id_token: id,
    email: 'top@example.com',
    ...overrides,
  };
}

describe('Codex import normalizer', () => {
  it('accepts flat, accounts, array, tokens, JSONL, BOM, and whitespace shapes', () => {
    const inputs = [
      JSON.stringify(validRecord()),
      JSON.stringify({ accounts: [validRecord()] }),
      JSON.stringify([validRecord(), validRecord({ email: 'two@example.com' })]),
      JSON.stringify({ tokens: validRecord({ email: undefined }) }),
      `\ufeff  ${JSON.stringify(validRecord())}  `,
      `${JSON.stringify(validRecord())}\n\n${JSON.stringify(validRecord({ email: 'two@example.com' }))}`,
    ];
    expect(inputs.map((input) => parseCodexImportText(input)).every((result) => result.length > 0)).toBe(true);
    expect(parseCodexImportText(inputs[1]!)).toHaveLength(1);
    expect(parseCodexImportText(inputs[2]!)).toHaveLength(2);
  });

  it('preserves the first 500 records and reports deterministic overflow', () => {
    const result = parseCodexImportText(JSON.stringify(Array.from({ length: 501 }, (_, index) => ({ access_token: `access-${index}`, refresh_token: `refresh-${index}` }))));
    expect(result).toHaveLength(501);
    expect('accessToken' in result[0]!).toBe(true);
    expect(result[499]).toMatchObject({ index: 499 });
    expect(result[500]).toMatchObject({ index: 500, error: 'Input exceeds maximum record count' });
  });

  it('isolates malformed JSON and missing required tokens by record index', () => {
    const malformed = parseCodexImportText('{bad json', 'fixture.json');
    expect(malformed).toEqual([{ index: 0, source: 'fixture.json', error: 'Malformed JSON input' }]);
    const missing = normalizeCodexRecord({ access_token: access }, 4);
    expect(missing).toMatchObject({ index: 4, error: 'Missing refresh token' });
    expect(JSON.stringify(missing)).not.toContain(access);
  });

  it('extracts JWT metadata with explicit metadata precedence and does not verify signatures', () => {
    const record = normalizeCodexRecord(validRecord({
      email: 'explicit@example.com',
      workspace_id: 'workspace-explicit',
      plan_type: 'team',
      expires_at: '2027-01-01T00:00:00.000Z',
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-account', chatgpt_plan_type: 'pro' }, 'https://api.openai.com/profile': { email: 'jwt@example.com' }, exp: 1 }),
    }), 0);
    expect(record).toMatchObject({ email: 'jwt@example.com', workspaceId: 'workspace-explicit', chatgptAccountId: 'jwt-account', planType: 'pro', expiresAt: '2027-01-01T00:00:00.000Z' });
  });

  it('resolves JWT, relative, and bounded fallback expiry deterministically', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const jwtRecord = normalizeCodexRecord(validRecord({ access_token: jwt({ exp: 1768003200 }) }), 0, now);
    expect(jwtRecord).toMatchObject({ expiresAt: '2026-01-10T00:00:00.000Z' });
    const relative = normalizeCodexRecord(validRecord({ expires_in: 3600 }), 0, now);
    expect(relative).toMatchObject({ expiresAt: '2026-01-01T01:00:00.000Z' });
    const fallback = normalizeCodexRecord(validRecord(), 0, now);
    expect(fallback).toMatchObject({ expiresAt: '2026-01-11T00:00:00.000Z' });
  });

  it('creates deterministic identity and secret-free preview/result DTOs', () => {
    const normalized = normalizeCodexRecord(validRecord({ workspace_id: 'workspace-1', chatgpt_account_id: 'account-1' }), 0) as NormalizedCodexRecord;
    const preview = toCodexPreview(normalized, null);
    expect(normalized.identity).toBe('account:account-1');
    expect(preview).not.toHaveProperty('accessToken');
    expect(preview).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(preview)).not.toContain(access);
    expect(JSON.stringify(preview)).not.toContain(refresh);
    expect(JSON.stringify(preview)).not.toContain(id);
    expect(preview.accountIdMasked).toBeTruthy();
    expect(preview.expiresAt).toBe(normalized.expiresAt);
    expect(preview).not.toHaveProperty('tokenExpiresAt');
  });

  it('never deduplicates unrelated same-email accounts', () => {
    const a = normalizeCodexRecord(validRecord({ email: 'same@example.com', access_token: 'token-a' }), 0) as NormalizedCodexRecord;
    const b = normalizeCodexRecord(validRecord({ email: 'same@example.com', access_token: 'token-b' }), 1) as NormalizedCodexRecord;
    expect(a.identity).not.toBe(b.identity);
    expect(a.identity).toMatch(/^token:/);
  });

  it('returns ParseFailure for invalid explicit expiry and safely rejects huge relative expiry', () => {
    expect(normalizeCodexRecord(validRecord({ expires_at: 'not-a-date' }), 2)).toMatchObject({ index: 2, error: 'Invalid explicit expiry' });
    expect(normalizeCodexRecord(validRecord({ expires_in: Number.MAX_VALUE }), 3)).toMatchObject({ index: 3, error: 'Invalid relative expiry' });
  });

  it('threads the deterministic clock through text parsing', () => {
    const result = parseCodexImportText(JSON.stringify(validRecord({ expires_in: '3600' })), undefined, new Date('2026-01-01T00:00:00.000Z'));
    expect(result).toMatchObject([{ expiresAt: '2026-01-01T01:00:00.000Z' }]);
  });

  it('merges auth and profile claims field-by-field across tokens', () => {
    const record = normalizeCodexRecord(validRecord({
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'access-account' }, 'https://api.openai.com/profile': { email: 'access@example.com' } }),
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'team' }, 'https://api.openai.com/profile': { email: 'id@example.com' } }),
    }), 0);
    expect(record).toMatchObject({ chatgptAccountId: 'access-account', planType: 'team', email: 'access@example.com' });
  });

  it('redacts normalized secrets and raw fixture text from import result JSON', async () => {
    const { toCodexImportResult } = await import('@server/providers/codex-import');
    const record = normalizeCodexRecord(validRecord(), 0) as NormalizedCodexRecord;
    const result = toCodexImportResult([record], [{ index: 1, error: 'bad raw fixture' }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(access);
    expect(serialized).not.toContain(refresh);
    expect(serialized).not.toContain(id);
    expect(serialized).not.toContain('bad raw fixture');
    expect(result.records).toHaveLength(1);
  });
});
