import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../../errors';
import { requireAdminAuth, requireAdminCsrf } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import {
  listCodexAccountSummaries,
  setCodexAccountHealth,
  toCodexAccountSummaryRow,
  upsertCodexAccount,
  findCodexAccountForImport,
  type DecryptedCodexCredentials,
} from '../../db/repositories/codex-accounts';
import { getRawDb } from '../../db/index';
import { parseCodexImportText, toCodexPreview, type NormalizedCodexRecord, type ParseFailure } from '../../providers/codex-import';
import { probeCodex } from '../../providers/codex';
import { fetchCodexResetCredits, consumeCodexResetCredit } from '../../providers/codex-usage';
import { codexCredentialError, withCodexCredentials } from '../../providers/codex-refresh';
import { buildCodexAuthorizeUrl, exchangeCodexCode, extractCodeFromCallback, newCodexPkce } from '../../providers/codex-oauth';
import { refreshStoredCodexUsage } from '../../providers/codex-autostart';
import { redactString } from '../../security/redact';

const MAX_BYTES = 2_000_000;
const MAX_RECORDS = 500;
const ImportBody = z.object({ providerId: z.string().min(1), selectedIndexes: z.array(z.number().int().min(0)).max(MAX_RECORDS).optional() });
const MutationOptions = { preHandler: requireAdminCsrf };
export const CodexAccountUpdate = z.object({
  enabled: z.boolean().optional(),
  email: z.string().email().nullable().optional(),
  workspaceId: z.string().max(256).nullable().optional(),
  planType: z.string().max(128).nullable().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
  autostart: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, 'At least one update is required');

type Input = { providerId: string; text: string; selectedIndexes?: number[] };

/** Credential failures must surface as typed admin errors, not an opaque 500. */
async function withCredentials<T>(accountId: string, fn: (credentials: DecryptedCodexCredentials) => Promise<T>): Promise<T> {
  try {
    return await withCodexCredentials(accountId, fn);
  } catch (error) {
    throw codexCredentialError(error);
  }
}

function parseAll(text: string): { records: NormalizedCodexRecord[]; failures: ParseFailure[] } {
  const result = parseCodexImportText(text);
  const records: NormalizedCodexRecord[] = [];
  const failures: ParseFailure[] = [];
  for (const item of result) ('accessToken' in item ? records : failures).push(item as never);
  return { records, failures };
}
type MultipartPart = { type: 'file'; file: AsyncIterable<Buffer>; fieldname: string; filename?: string } | { type: 'field'; fieldname: string; value: string };
type AccountSummaryRow = Parameters<typeof toCodexAccountSummaryRow>[0];

function providerOrThrow(providerId: string): { id: string; type: string; base_url: string; total_timeout_ms: number } {
  const provider = getRawDb().prepare('SELECT id,type,base_url,total_timeout_ms FROM providers WHERE id=?').get(providerId) as { id: string; type: string; base_url: string; total_timeout_ms: number } | undefined;
  if (!provider) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
  if (provider.type !== 'codex') throw new GatewayError('invalid_request_error', 'Provider must be Codex', { status: 400 });
  return provider;
}

/**
 * Desktop/e2e flows cannot always hand a real File to a multipart file part, so a file part whose
 * name lacks a text extension is accepted as base64 of the JSON payload.
 */
const TEXT_EXT = /\.(json|jsonl|txt)$/i;

async function readInput(req: FastifyRequest, body: unknown): Promise<Input> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('multipart/form-data')) {
    const parts = (req as FastifyRequest & { parts: () => AsyncIterable<MultipartPart> }).parts();
    let providerId = '';
    let selectedIndexes: number[] | undefined;
    const texts: string[] = [];
    let bytes = 0;
    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) { bytes += chunk.length; if (bytes > MAX_BYTES) throw new GatewayError('invalid_request_error', 'Import exceeds maximum size', { status: 413 }); chunks.push(chunk); }
        const raw = Buffer.concat(chunks).toString('utf8');
        texts.push(TEXT_EXT.test(part.filename ?? '') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
      } else if (part.fieldname === 'providerId') providerId = String(part.value);
      else if (part.fieldname === 'selectedIndexes') {
        let parsedIndexes: unknown;
        try { parsedIndexes = JSON.parse(String(part.value)); } catch { throw new GatewayError('invalid_request_error', 'selectedIndexes must be JSON', { status: 400 }); }
        selectedIndexes = z.array(z.number().int().min(0)).max(MAX_RECORDS).parse(parsedIndexes);
      }
      else if (part.fieldname === 'text') texts.push(String(part.value));
    }
    return { providerId, text: texts.join('\n'), selectedIndexes };
  }
  const parsed = ImportBody.extend({ text: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]) }).parse(body);
  const text = typeof parsed.text === 'string' ? parsed.text : JSON.stringify(parsed.text);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new GatewayError('invalid_request_error', 'Import exceeds maximum size', { status: 413 });
  return { providerId: parsed.providerId, text, selectedIndexes: parsed.selectedIndexes };
}

const selectAccount = "SELECT id,email,workspace_id AS workspaceId,chatgpt_account_id AS chatgptAccountId,plan_type AS planType,token_expires_at AS tokenExpiresAt,enabled,health_state AS healthState,last_refresh_at AS lastRefreshAt,priority,codex_autostart_enabled AS autostart,codex_usage_json AS usageJson,codex_usage_error AS usageError,codex_usage_updated_at AS usageUpdatedAt,last_pinged_reset_at AS lastPingedResetAt,last_ping_at AS lastPingAt,created_at AS createdAt,updated_at AS updatedAt FROM codex_accounts WHERE id=?";

function accountById(id: string): AccountSummaryRow {
  const row = getRawDb().prepare(selectAccount).get(id) as AccountSummaryRow | undefined;
  if (!row) throw new GatewayError('invalid_request_error', 'Codex account not found', { status: 404 });
  return row;
}

/** Narrow seam onto the Codex account row so quota routes can read provider + identity. */
function accountTarget(id: string): { providerId: string; accountId: string | null; provider: { id: string; base_url: string; total_timeout_ms: number } } {
  const row = getRawDb().prepare('SELECT provider_id AS providerId, chatgpt_account_id AS accountId FROM codex_accounts WHERE id=?').get(id) as { providerId: string; accountId: string | null } | undefined;
  if (!row) throw new GatewayError('invalid_request_error', 'Codex account not found', { status: 404 });
  return { ...row, provider: providerOrThrow(row.providerId) };
}

/**
 * Server-held PKCE sessions. The challenge must derive from the verifier used at exchange time,
 * so the verifier never leaves the process; the dialog polls this state instead.
 */
const oauthSessions = new Map<string, { verifier: string; providerId: string; createdAt: number; code?: string }>();
const OAUTH_TTL_MS = 15 * 60_000;
const reapOauthSessions = () => {
  const cutoff = Date.now() - OAUTH_TTL_MS;
  for (const [state, session] of oauthSessions) if (session.createdAt < cutoff) oauthSessions.delete(state);
};

/**
 * Loopback capture endpoint for the Codex CLI redirect (http://localhost:1455/auth/callback).
 * Registered outside the admin scope because the browser's redirect carries no session; the code
 * is held in memory against its state and exchanged only by /oauth/complete.
 */
export async function registerCodexOAuthCallbackRoute(app: FastifyInstance): Promise<void> {
  app.get('/oauth/codex/callback', async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    reapOauthSessions();
    const session = state ? oauthSessions.get(state) : undefined;
    if (session && code) session.code = code;
    const failed = Boolean(error) || !session || !code;
    reply.type('text/html').send(
      `<!doctype html><meta charset="utf-8"><title>LateDev Router</title><body style="font:14px system-ui;padding:2rem">` +
      (failed
        ? `<h1>Authorization failed</h1><p>${session ? 'No authorization code was returned. Close this tab and try again.' : 'This authorization session is unknown or has expired.'}</p>`
        : `<h1>Account connected</h1><p>You can close this tab and return to LateDev Router.</p>`),
      // No code, state, or token is echoed — the admin UI retrieves it from the API.
    );
  });
}

export async function registerCodexRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.post('/api/admin/codex/accounts/preview', { preHandler: requireAdminCsrf }, async (req) => {
    const input = await readInput(req, req.body);
    providerOrThrow(input.providerId);
    const parsed = parseAll(input.text);
    const seen = new Map<string, number>();
    const records = parsed.records.map((record) => {
      const duplicateOf = seen.get(record.identity);
      seen.set(record.identity, record.index);
      const existing = findCodexAccountForImport(input.providerId, { chatgptAccountId: record.chatgptAccountId, workspaceId: record.workspaceId, email: record.email, tokenDigest: '' });
      return { ...toCodexPreview(record, duplicateOf === undefined ? (existing?.id ?? null) : String(duplicateOf)), duplicateOf: duplicateOf === undefined ? (existing?.id ?? null) : String(duplicateOf) };
    });
    return { records: [...records, ...parsed.failures.map((f) => ({ index: f.index, source: f.source, valid: false, error: 'Invalid record' }))], validCount: records.length, invalidCount: parsed.failures.length };
  });

  app.post('/api/admin/codex/accounts/import', MutationOptions, async (req) => {
    const input = await readInput(req, req.body);
    providerOrThrow(input.providerId);
    const parsed = parseAll(input.text);
    const selected = input.selectedIndexes ? new Set(input.selectedIndexes) : null;
    const results: Array<Record<string, unknown>> = [];
    let added = 0; let updated = 0; let skipped = 0; let failed = 0;
    for (const failure of parsed.failures) { if (!selected || selected.has(failure.index)) { failed++; results.push({ index: failure.index, status: 'failed', error: 'Invalid record' }); } else skipped++; }
    for (const record of parsed.records) {
      if (selected && !selected.has(record.index)) { skipped++; continue; }
      try {
        const result = upsertCodexAccount(input.providerId, record);
        if (result.status === 'added') added++; else updated++;
        results.push({ index: record.index, status: result.status, email: record.email, accountIdMasked: toCodexPreview(record).accountIdMasked });
      } catch (error) { failed++; results.push({ index: record.index, status: 'failed', error: 'Import failed' }); void error; }
    }
    recordAudit({ action: 'codex.accounts.import', success: failed === 0, targetType: 'provider', targetId: input.providerId, ip: req.ip, metadata: { added, updated, skipped, failed } });
    return { added, updated, skipped, failed, results };
  });

  app.get('/api/admin/codex/accounts', async (req) => {
    const providerId = z.object({ providerId: z.string().min(1) }).parse(req.query).providerId;
    providerOrThrow(providerId);
    return { accounts: listCodexAccountSummaries(providerId) };
  });

  /** Drag-and-drop routing order. The posted array order becomes priority 0..n-1. */
  const ReorderBody = z.object({ providerId: z.string().min(1), ids: z.array(z.string().min(1)).min(1).max(MAX_RECORDS) });
  app.post('/api/admin/codex/accounts/reorder', MutationOptions, async (req) => {
    const { providerId, ids } = ReorderBody.parse(req.body);
    providerOrThrow(providerId);
    const owned = new Set(listCodexAccountSummaries(providerId).map((account) => account.id));
    if (ids.some((id) => !owned.has(id))) throw new GatewayError('invalid_request_error', 'Account list does not match the provider', { status: 400 });
    const raw = getRawDb();
    const now = new Date().toISOString();
    const update = raw.prepare('UPDATE codex_accounts SET priority=?, updated_at=? WHERE id=?');
    raw.transaction(() => ids.forEach((id, index) => update.run(index, now, id)))();
    recordAudit({ action: 'codex.accounts.reorder', success: true, targetType: 'provider', targetId: providerId, ip: req.ip, metadata: { count: ids.length } });
    return { accounts: listCodexAccountSummaries(providerId) };
  });

  app.post('/api/admin/codex/oauth/start', MutationOptions, async (req) => {
    const { providerId } = z.object({ providerId: z.string().min(1) }).parse(req.body);
    providerOrThrow(providerId);
    reapOauthSessions();
    const { verifier, state } = newCodexPkce();
    oauthSessions.set(state, { verifier, providerId, createdAt: Date.now() });
    return { state, authorizeUrl: buildCodexAuthorizeUrl(verifier, state) };
  });

  app.get('/api/admin/codex/oauth/:state', async (req) => {
    const { state } = req.params as { state: string };
    reapOauthSessions();
    const session = oauthSessions.get(state);
    // Poll target for the dialog: reports whether the loopback callback already delivered a code.
    if (!session) throw new GatewayError('invalid_request_error', 'Authorization session not found or expired', { status: 404 });
    return { pending: true, callbackReceived: Boolean(session.code), providerId: session.providerId, expiresInMs: session.createdAt + OAUTH_TTL_MS - Date.now() };
  });


  /**
   * Completes the flow from either the browser's loopback redirect or a pasted callback URL/code.
   * The matching session is consumed, so a code can only be exchanged once.
   */
  app.post('/api/admin/codex/oauth/complete', MutationOptions, async (req) => {
    const body = z.object({ providerId: z.string().min(1), state: z.string().min(1).optional(), callbackUrl: z.string().min(1).max(8192) }).parse(req.body);
    providerOrThrow(body.providerId);
    const fallbackState = [...oauthSessions.entries()].filter(([, session]) => session.providerId === body.providerId).sort((a, b) => b[1].createdAt - a[1].createdAt)[0]?.[0];
    const state = body.state ?? fallbackState;
    const session = state ? oauthSessions.get(state) : undefined;
    if (!state || !session || session.providerId !== body.providerId) throw new GatewayError('invalid_request_error', 'Authorization session not found or expired', { status: 409 });
    const code = extractCodeFromCallback(body.callbackUrl) ?? session.code;
    if (!code) throw new GatewayError('invalid_request_error', 'Could not find an authorization code in the pasted value', { status: 400 });
    try {
      const record = await exchangeCodexCode({ code, verifier: session.verifier });
      oauthSessions.delete(state);
      const result = upsertCodexAccount(body.providerId, record);
      recordAudit({ action: 'codex.oauth.connect', success: true, targetType: 'codex_account', targetId: result.id, targetName: record.email ?? undefined, ip: req.ip, metadata: { status: result.status } });
      return { account: toCodexAccountSummaryRow(accountById(result.id)), status: result.status };
    } catch (error) {
      const status = (error as { status?: number }).status ?? 502;
      throw new GatewayError('authentication_error', redactString(error instanceof Error ? error.message : 'Codex authorization failed'), { status });
    }
  });

  app.patch('/api/admin/codex/accounts/:id', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const body = CodexAccountUpdate.parse(req.body);
    accountById(id);
    const raw = getRawDb();
    const fields: string[] = []; const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      const column = ({ enabled: 'enabled', email: 'email', workspaceId: 'workspace_id', planType: 'plan_type', priority: 'priority', autostart: 'codex_autostart_enabled' } as Record<string, string>)[key];
      if (column) { fields.push(`${column}=?`); values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value); }
    }
    fields.push('updated_at=?'); values.push(new Date().toISOString(), id);
    raw.prepare(`UPDATE codex_accounts SET ${fields.join(',')} WHERE id=?`).run(...values);
    recordAudit({ action: 'codex.accounts.update', success: true, targetType: 'codex_account', targetId: id, ip: req.ip, metadata: { fields: Object.keys(body) } });
    return { account: toCodexAccountSummaryRow(accountById(id)) };
  });

  app.delete('/api/admin/codex/accounts/:id', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const account = accountById(id);
    // Hard delete: the encrypted credentials must not linger on disk. Historical request attempts
    // survive because request_attempts.codex_account_id is ON DELETE SET NULL.
    getRawDb().prepare('DELETE FROM codex_accounts WHERE id=?').run(id);
    recordAudit({ action: 'codex.accounts.delete', success: true, targetType: 'codex_account', targetId: id, targetName: account.email ?? undefined, ip: req.ip });
    return { ok: true, deleted: true };
  });

  app.post('/api/admin/codex/accounts/:id/test', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const { provider, accountId } = accountTarget(id);
    const result = await withCredentials(id, (credentials) => probeCodex({
      baseUrl: provider.base_url, accountId: accountId ?? '', accessToken: credentials.accessToken,
      accountRecordId: id, customHeaders: {}, totalTimeoutMs: Math.min(provider.total_timeout_ms, 20_000),
    }));
    setCodexAccountHealth(id, result.ok ? 'healthy' : 'down', result.ok ? null : redactString(result.detail));
    recordAudit({ action: 'codex.accounts.test', success: result.ok, targetType: 'codex_account', targetId: id, ip: req.ip, metadata: { detail: redactString(result.detail) } });
    return { ok: result.ok, detail: redactString(result.detail), latencyMs: result.latencyMs, modelCount: result.modelCount ?? null };
  });

  /** Refresh the 5h/weekly quota snapshot for one account. */
  app.post('/api/admin/codex/accounts/:id/usage', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const { provider, accountId } = accountTarget(id);
    await refreshStoredCodexUsage(id, provider, { id, chatgpt_account_id: accountId });
    return { account: toCodexAccountSummaryRow(accountById(id)) };
  });

  /** Weekly reset credits available on the ChatGPT account. */
  app.get('/api/admin/codex/accounts/:id/reset-credits', async (req) => {
    const { id } = req.params as { id: string };
    const { accountId } = accountTarget(id);
    const result = await withCredentials(id, (credentials) => fetchCodexResetCredits(credentials.accessToken, accountId ?? undefined));
    return result;
  });

  /** Spend one weekly reset credit to restart the 5h window immediately. */
  app.post('/api/admin/codex/accounts/:id/reset-quota', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const { provider, accountId } = accountTarget(id);
    const result = await withCredentials(id, (credentials) => consumeCodexResetCredit(credentials.accessToken, accountId ?? undefined));
    if (result.ok) await refreshStoredCodexUsage(id, provider, { id, chatgpt_account_id: accountId });
    recordAudit({ action: 'codex.accounts.reset_quota', success: result.ok, targetType: 'codex_account', targetId: id, ip: req.ip, metadata: { code: result.code, windowsReset: result.windowsReset } });
    if (!result.ok) {
      const status = result.noCredit ? 409 : 502;
      throw new GatewayError('invalid_request_error', result.noCredit ? 'No Codex reset credits available' : redactString(result.message ?? 'Codex reset credit request failed'), { status });
    }
    return { ok: true, windowsReset: result.windowsReset, account: toCodexAccountSummaryRow(accountById(id)) };
  });
}
