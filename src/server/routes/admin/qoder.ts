import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../../errors';
import { requireAdminAuth, requireAdminCsrf } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { getRawDb } from '../../db/index';
import { uuid } from '../../auth/ids';
import {
  listQoderAccountSummaries,
  getQoderAccountDetailById,
  setQoderAccountHealth,
  upsertQoderAccount,
  findQoderAccountForImport,
  saveQoderCatalog,
  toQoderAccountSummary,
  type NormalizedQoderRecord,
  type QoderAccountSummary,
} from '../../db/repositories/qoder-accounts';
import { exchangeQoderPat, fetchQoderCatalog, serializeCatalog, type QoderCatalog } from '../../providers/qoder/catalog';
import { probeQoder } from '../../providers/qoder/client';
import { qoderCredentialsFor, withQoderCredentials } from '../../providers/qoder/credentials';
import { parseQoderImportText, toQoderPreview, qoderTokenFingerprint, type NormalizedQoderToken, type QoderParseFailure } from '../../providers/qoder/qoder-import';
import { redactString } from '../../security/redact';

const MAX_BYTES = 2_000_000;
const MAX_RECORDS = 500;
const ImportBody = z.object({ providerId: z.string().min(1), selectedIndexes: z.array(z.number().int().min(0)).max(MAX_RECORDS).optional() });
const MutationOptions = { preHandler: requireAdminCsrf };
export const QoderAccountUpdate = z.object({
  enabled: z.boolean().optional(),
  label: z.string().max(256).nullable().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
}).refine((v) => Object.keys(v).length > 0, 'At least one update is required');

type Input = { providerId: string; text: string; selectedIndexes?: number[] };

function parseAll(text: string): { records: NormalizedQoderToken[]; failures: QoderParseFailure[] } {
  const result = parseQoderImportText(text);
  const records: NormalizedQoderToken[] = [];
  const failures: QoderParseFailure[] = [];
  for (const item of result) ('personalToken' in item ? records : failures).push(item as never);
  return { records, failures };
}

function providerOrThrow(providerId: string): { id: string; type: string; total_timeout_ms: number } {
  const provider = getRawDb().prepare('SELECT id,type,total_timeout_ms FROM providers WHERE id=?').get(providerId) as { id: string; type: string; total_timeout_ms: number } | undefined;
  if (!provider) throw new GatewayError('invalid_request_error', 'Provider not found', { status: 404 });
  if (provider.type !== 'qoder') throw new GatewayError('invalid_request_error', 'Provider must be Qoder', { status: 400 });
  return provider;
}

type MultipartPart = { type: 'file'; file: AsyncIterable<Buffer>; fieldname: string; filename?: string } | { type: 'field'; fieldname: string; value: string };
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
      } else if (part.fieldname === 'text') texts.push(String(part.value));
    }
    return { providerId, text: texts.join('\n'), selectedIndexes };
  }
  const parsed = ImportBody.extend({ text: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]) }).parse(body);
  const text = typeof parsed.text === 'string' ? parsed.text : JSON.stringify(parsed.text);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new GatewayError('invalid_request_error', 'Import exceeds maximum size', { status: 413 });
  return { providerId: parsed.providerId, text, selectedIndexes: parsed.selectedIndexes };
}

function summaryOrThrow(id: string): QoderAccountSummary {
  const row = getQoderAccountDetailById(id);
  if (!row) throw new GatewayError('invalid_request_error', 'Qoder account not found', { status: 404 });
  return toQoderAccountSummary(row);
}

/**
 * A PAT that works but a catalog that 502s is recoverable — the operator retries later — so the
 * exchange result is stored even when the catalog fetch fails. When the exchange itself fails
 * nothing is written and the error is redacted.
 */
async function exchangeAndCatalog(personalToken: string, machineId: string): Promise<{ record: Omit<NormalizedQoderRecord, 'index' | 'source'>, catalog: QoderCatalog | null, catalogError: string | null }> {
  let exchanged;
  try {
    exchanged = await exchangeQoderPat(personalToken);
  } catch (error) {
    throw new GatewayError('authentication_error', redactString(error instanceof Error ? error.message : 'Qoder personal access token was rejected'), { status: 401 });
  }
  let catalog: QoderCatalog | null = null;
  let catalogError: string | null = null;
  try {
    catalog = await fetchQoderCatalog({ jobToken: exchanged.jobToken, userId: exchanged.qoderUserId, machineId });
    // fetchQoderCatalog reports failure by returning null rather than throwing, so a null here is
    // exactly the "token works, catalog did not" case the account survives.
    if (!catalog || catalog.entries.size === 0) catalogError = 'Qoder model catalog could not be fetched';
  } catch (error) {
    catalogError = redactString(error instanceof Error ? error.message : 'Qoder model catalog could not be fetched');
  }
  return {
    record: {
      personalToken, jobToken: exchanged.jobToken, jobTokenExpiresAt: exchanged.jobTokenExpiresAt,
      qoderUserId: exchanged.qoderUserId, machineId, email: exchanged.email, label: exchanged.label,
    },
    catalog,
    catalogError,
  };
}

export async function registerQoderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  /** Add one account: exchange first, then store, so a bad PAT never reaches the database. */
  app.post('/api/admin/qoder/accounts', MutationOptions, async (req) => {
    const body = z.object({ providerId: z.string().min(1), personalToken: z.string().min(1).max(200_000), label: z.string().max(256).nullable().optional() }).parse(req.body);
    providerOrThrow(body.providerId);
    const { record, catalog, catalogError } = await exchangeAndCatalog(body.personalToken, uuid());
    const result = upsertQoderAccount(body.providerId, { ...record, index: 0, label: body.label ?? record.label, source: 'manual' });
    // The catalog fetched during the exchange is the proof the PAT works, so persist it rather
    // than throwing it away and leaving the account with no routable models until a manual refresh.
    if (catalog) saveQoderCatalog(result.id, serializeCatalog(catalog), catalog.fetchedAt);
    if (catalogError) setQoderAccountHealth(result.id, 'unknown', catalogError);
    recordAudit({ action: 'qoder.accounts.add', success: true, targetType: 'qoder_account', targetId: result.id, targetName: record.label ?? undefined, ip: req.ip, metadata: { status: result.status, catalogError: catalogError ? 'yes' : 'no' } });
    return { account: summaryOrThrow(result.id), status: result.status, catalogError };
  });

  app.post('/api/admin/qoder/accounts/preview', MutationOptions, async (req) => {
    const input = await readInput(req, req.body);
    providerOrThrow(input.providerId);
    const parsed = parseAll(input.text);
    const seen = new Map<string, number>();
    const records = parsed.records.map((record) => {
      const fingerprint = qoderTokenFingerprint(record.personalToken);
      const duplicateOf = seen.get(fingerprint);
      seen.set(fingerprint, record.index);
      const existing = findQoderAccountForImport(input.providerId, record.personalToken);
      const resolved = duplicateOf === undefined ? (existing ?? null) : String(duplicateOf);
      return toQoderPreview(record, resolved);
    });
    return {
      records: [...records, ...parsed.failures.map((f) => ({ index: f.index, source: f.source, valid: false, error: f.error }))],
      validCount: records.length,
      invalidCount: parsed.failures.length,
    };
  });

  app.post('/api/admin/qoder/accounts/import', MutationOptions, async (req) => {
    const input = await readInput(req, req.body);
    providerOrThrow(input.providerId);
    const parsed = parseAll(input.text);
    const selected = input.selectedIndexes ? new Set(input.selectedIndexes) : null;
    const results: Array<Record<string, unknown>> = [];
    let added = 0; let updated = 0; let skipped = 0; let failed = 0;
    for (const failure of parsed.failures) {
      if (!selected || selected.has(failure.index)) { failed++; results.push({ index: failure.index, status: 'failed', error: failure.error }); } else skipped++;
    }
    for (const record of parsed.records) {
      if (selected && !selected.has(record.index)) { skipped++; continue; }
      try {
        const { record: exchanged, catalog, catalogError } = await exchangeAndCatalog(record.personalToken, uuid());
        const result = upsertQoderAccount(input.providerId, { ...exchanged, index: record.index, label: record.label, source: record.source });
        if (catalog) saveQoderCatalog(result.id, serializeCatalog(catalog), catalog.fetchedAt);
        if (catalogError) setQoderAccountHealth(result.id, 'unknown', catalogError);
        if (result.status === 'inserted') added++; else updated++;
        results.push({ index: record.index, status: result.status, label: record.label, masked: toQoderPreview(record).personalTokenMasked });
      } catch (error) {
        failed++;
        results.push({ index: record.index, status: 'failed', error: redactString(error instanceof Error ? error.message : 'Import failed') });
      }
    }
    recordAudit({ action: 'qoder.accounts.import', success: failed === 0, targetType: 'provider', targetId: input.providerId, ip: req.ip, metadata: { added, updated, skipped, failed } });
    return { added, updated, skipped, failed, results };
  });

  app.get('/api/admin/qoder/accounts', async (req) => {
    const providerId = z.object({ providerId: z.string().min(1) }).parse(req.query).providerId;
    providerOrThrow(providerId);
    return { accounts: listQoderAccountSummaries(providerId) };
  });

  const ReorderBody = z.object({ providerId: z.string().min(1), ids: z.array(z.string().min(1)).min(1).max(MAX_RECORDS) });
  app.post('/api/admin/qoder/accounts/reorder', MutationOptions, async (req) => {
    const { providerId, ids } = ReorderBody.parse(req.body);
    providerOrThrow(providerId);
    const owned = new Set(listQoderAccountSummaries(providerId).map((account) => account.id));
    if (ids.some((id) => !owned.has(id))) throw new GatewayError('invalid_request_error', 'Account list does not match the provider', { status: 400 });
    const raw = getRawDb();
    const now = new Date().toISOString();
    const update = raw.prepare('UPDATE qoder_accounts SET priority=?, updated_at=? WHERE id=?');
    raw.transaction(() => ids.forEach((id, index) => update.run(index, now, id)))();
    recordAudit({ action: 'qoder.accounts.reorder', success: true, targetType: 'provider', targetId: providerId, ip: req.ip, metadata: { count: ids.length } });
    return { accounts: listQoderAccountSummaries(providerId) };
  });

  app.patch('/api/admin/qoder/accounts/:id', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const body = QoderAccountUpdate.parse(req.body);
    summaryOrThrow(id);
    const raw = getRawDb();
    const fields: string[] = []; const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      const column = ({ enabled: 'enabled', label: 'label', priority: 'priority' } as Record<string, string>)[key];
      if (column) { fields.push(`${column}=?`); values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value); }
    }
    fields.push('updated_at=?'); values.push(new Date().toISOString(), id);
    raw.prepare(`UPDATE qoder_accounts SET ${fields.join(',')} WHERE id=?`).run(...values);
    recordAudit({ action: 'qoder.accounts.update', success: true, targetType: 'qoder_account', targetId: id, ip: req.ip, metadata: { fields: Object.keys(body) } });
    return { account: summaryOrThrow(id) };
  });

  app.delete('/api/admin/qoder/accounts/:id', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const account = summaryOrThrow(id);
    // Hard delete: the encrypted PAT must not linger on disk. Historical attempts survive via
    // request_attempts.qoder_account_id ON DELETE SET NULL.
    getRawDb().prepare('DELETE FROM qoder_accounts WHERE id=?').run(id);
    recordAudit({ action: 'qoder.accounts.delete', success: true, targetType: 'qoder_account', targetId: id, targetName: account.label ?? undefined, ip: req.ip });
    return { ok: true, deleted: true };
  });

  app.post('/api/admin/qoder/accounts/:id/test', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    const account = getQoderAccountDetailById(id);
    if (!account) throw new GatewayError('invalid_request_error', 'Qoder account not found', { status: 404 });
    const provider = providerOrThrow(account.providerId);
    const result = await withQoderCredentials(id, (config) => probeQoder({ ...config, accountRecordId: id, totalTimeoutMs: Math.min(provider.total_timeout_ms, 20_000) }));
    setQoderAccountHealth(id, result.ok ? 'healthy' : 'down', result.ok ? null : redactString(result.detail));
    recordAudit({ action: 'qoder.accounts.test', success: result.ok, targetType: 'qoder_account', targetId: id, ip: req.ip, metadata: { detail: redactString(result.detail) } });
    return { ok: result.ok, detail: redactString(result.detail), latencyMs: result.latencyMs, modelCount: result.modelCount ?? null };
  });

  /** Force-mint a job token and re-fetch the catalog. Returns counts and keys, never the blob. */
  app.post('/api/admin/qoder/accounts/:id/catalog', MutationOptions, async (req) => {
    const { id } = req.params as { id: string };
    if (!getQoderAccountDetailById(id)) throw new GatewayError('invalid_request_error', 'Qoder account not found', { status: 404 });
    const { config } = await qoderCredentialsFor(id, { force: true });
    const keys = config.catalog ? [...config.catalog.entries.keys()] : [];
    recordAudit({ action: 'qoder.accounts.catalog', success: Boolean(config.catalog), targetType: 'qoder_account', targetId: id, ip: req.ip, metadata: { modelCount: keys.length } });
    return { modelCount: keys.length, modelKeys: keys, catalogFetchedAt: config.catalog?.fetchedAt ?? null };
  });
}
