import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../../errors';
import { requireAdminAuth, requireAdminCsrf } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import {
  listCodexAccountSummaries,
  setCodexAccountHealth,
  toCodexAccountSummary,
  upsertCodexAccount,
  findCodexAccountForImport,
} from '../../db/repositories/codex-accounts';
import { getRawDb } from '../../db/index';
import { parseCodexImportText, toCodexPreview, type NormalizedCodexRecord, type ParseFailure } from '../../providers/codex-import';

const MAX_BYTES = 2_000_000;
const MAX_RECORDS = 500;
const ImportBody = z.object({ providerId: z.string().min(1), selectedIndexes: z.array(z.number().int().min(0)).max(MAX_RECORDS).optional() });
const MutationOptions = { preHandler: requireAdminCsrf };
const UpdateBody = z.object({ enabled: z.boolean().optional(), email: z.string().email().nullable().optional(), workspaceId: z.string().max(256).nullable().optional(), planType: z.string().max(128).nullable().optional(), priority: z.number().int().min(0).max(100000).optional() }).refine((v) => Object.keys(v).length > 0, 'At least one update is required');

type Input = { providerId: string; text: string; selectedIndexes?: number[] };

function parseAll(text: string): { records: NormalizedCodexRecord[]; failures: ParseFailure[] } {
  const result = parseCodexImportText(text);
  const records: NormalizedCodexRecord[] = [];
  const failures: ParseFailure[] = [];
  for (const item of result) ('accessToken' in item ? records : failures).push(item as never);
  return { records, failures };
}
type MultipartPart = { type: 'file'; file: AsyncIterable<Buffer>; fieldname: string } | { type: 'field'; fieldname: string; value: string };
type AccountSummaryRow = Parameters<typeof toCodexAccountSummary>[0];

function providerOrThrow(providerId: string): { id: string; type: string; base_url: string } {
  const provider = getRawDb().prepare('SELECT id,type,base_url FROM providers WHERE id=?').get(providerId) as { id: string; type: string; base_url: string } | undefined;
  if (!provider) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
  if (provider.type !== 'codex') throw new GatewayError('invalid_request_error', 'Provider must be Codex', { status: 400 });
  return provider;
}


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
        texts.push(Buffer.concat(chunks).toString('utf8'));
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

const parse = parseAll;

export async function registerCodexRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  const preview = async (req: FastifyRequest) => {
    const input = await readInput(req, req.body);
    providerOrThrow(input.providerId);
    const parsed = parse(input.text);
    const seen = new Map<string, number>();
    const records = parsed.records.map((record) => {
      const duplicateOf = seen.get(record.identity);
      seen.set(record.identity, record.index);
      const existing = findCodexAccountForImport(input.providerId, { chatgptAccountId: record.chatgptAccountId, workspaceId: record.workspaceId, email: record.email, tokenDigest: '' });
      return { ...toCodexPreview(record, duplicateOf === undefined ? (existing?.id ?? null) : String(duplicateOf)), duplicateOf: duplicateOf === undefined ? (existing?.id ?? null) : String(duplicateOf) };
    });
    return { records: [...records, ...parsed.failures.map((f) => ({ index: f.index, source: f.source, valid: false, error: 'Invalid record' }))], validCount: records.length, invalidCount: parsed.failures.length };
  };
  app.post('/api/admin/codex/accounts/preview', { preHandler: requireAdminCsrf }, preview);

  app.post('/api/admin/codex/accounts/import', MutationOptions, async (req) => {
    const input = await readInput(req, req.body);
    providerOrThrow(input.providerId);
    const parsed = parse(input.text);
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

  app.patch('/api/admin/codex/accounts/:id', MutationOptions, async (req) => {
    const id = (req.params as { id: string }).id;
    const body = UpdateBody.parse(req.body);
    const raw = getRawDb();
    const row = raw.prepare('SELECT id FROM codex_accounts WHERE id=?').get(id) as { id: string } | undefined;
    if (!row) throw new GatewayError('invalid_request_error', 'Codex account not found', { status: 404 });
    const fields: string[] = []; const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) { const column = ({ enabled: 'enabled', email: 'email', workspaceId: 'workspace_id', planType: 'plan_type', priority: 'priority' } as Record<string, string>)[key]; if (column) { fields.push(`${column}=?`); values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value); } }
    fields.push('updated_at=?'); values.push(new Date().toISOString(), id); raw.prepare(`UPDATE codex_accounts SET ${fields.join(',')} WHERE id=?`).run(...values);
    recordAudit({ action: 'codex.accounts.update', success: true, targetType: 'codex_account', targetId: id, ip: req.ip });
    const updated = raw.prepare('SELECT id,email,workspace_id AS workspaceId,chatgpt_account_id AS chatgptAccountId,plan_type AS planType,token_expires_at AS tokenExpiresAt,enabled,health_state AS healthState,last_refresh_at AS lastRefreshAt,priority,created_at AS createdAt,updated_at AS updatedAt FROM codex_accounts WHERE id=?').get(id) as AccountSummaryRow;
    return { account: toCodexAccountSummary(updated) };
  });

  app.delete('/api/admin/codex/accounts/:id', MutationOptions, async (req) => {
    const id = (req.params as { id: string }).id;
    const row = getRawDb().prepare('SELECT id FROM codex_accounts WHERE id=?').get(id);
    if (!row) throw new GatewayError('invalid_request_error', 'Codex account not found', { status: 404 });
    setCodexAccountHealth(id, 'down', 'Disabled by administrator', false);
    recordAudit({ action: 'codex.accounts.disable', success: true, targetType: 'codex_account', targetId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/codex/accounts/:id/test', MutationOptions, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getRawDb().prepare('SELECT id,provider_id FROM codex_accounts WHERE id=?').get(id) as { id: string; provider_id: string } | undefined;
    if (!row) throw new GatewayError('invalid_request_error', 'Codex account not found', { status: 404 });
    providerOrThrow(row.provider_id);
    return reply.code(501).send({ error: { type: 'not_implemented', message: 'Codex account testing is not implemented until the Codex adapter is available' } });
  });
}
