// Qoder account pool: the upstream credential is a per-account personal access token
// (`pt-…`) exchanged for a short-lived job token (`jt-…`). Both are encrypted at rest;
// nothing here ever returns them in a summary.
import { decryptSecret, encryptSecret } from '../../auth/crypto';
import { uuid } from '../../auth/ids';
import { createHash } from 'node:crypto';
import { getRawDb } from '../index';
import type { QoderCredits } from '../../providers/qoder/credits';

export interface DecryptedQoderCredentials {
  personalToken: string;
  jobToken: string;
  jobTokenExpiresAt: string;
}

export interface QoderIdentity {
  qoderUserId: string;
  machineId: string;
  email: string | null;
  label: string | null;
}

export interface NormalizedQoderRecord {
  index: number;
  personalToken: string;
  jobToken: string;
  jobTokenExpiresAt: string;
  qoderUserId: string;
  machineId: string;
  email: string | null;
  label: string | null;
  source?: string;
}

export interface QoderAccountSummary {
  id: string;
  label: string | null;
  email: string | null;
  qoderUserIdMasked: string | null;
  enabled: boolean;
  healthState: string;
  priority: number;
  jobTokenExpiresAt: string;
  catalogFetchedAt: string | null;
  /** Parsed Credits snapshot. The raw column never reaches the API layer. */
  credits: QoderCredits | null;
  creditsUpdatedAt: string | null;
  creditsError: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

/** A corrupted or absent snapshot reads as "no data", never as a thrown error on a list call. */
function parseStoredCredits(json: string | null): QoderCredits | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as QoderCredits;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export interface QoderAccountDetail extends QoderAccountSummary {
  providerId: string;
  qoderUserId: string;
  machineId: string;
}

export interface QoderAccountCandidate {
  id: string;
  qoderUserId: string;
  enabled: boolean;
  healthState: string;
  priority: number;
}

export function maskQoderValue(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 8 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function identityFromQoderRecord(record: NormalizedQoderRecord): QoderIdentity {
  return {
    qoderUserId: record.qoderUserId,
    machineId: record.machineId,
    email: record.email,
    label: record.label,
  };
}

const SUMMARY_COLUMNS =
  'id,provider_id AS providerId,label,email,qoder_user_id AS qoderUserId,machine_id AS machineId,enabled,health_state AS healthState,priority,job_token_expires_at AS jobTokenExpiresAt,catalog_fetched_at AS catalogFetchedAt,credits_json AS creditsJson,credits_updated_at AS creditsUpdatedAt,credits_error AS creditsError,last_error AS lastError,consecutive_failures AS consecutiveFailures,created_at AS createdAt,updated_at AS updatedAt';

// Two callers hand this either a raw row (serialized `creditsJson`) or an already-mapped detail
// (parsed `credits`), so both spellings are accepted and the summary exposes one parsed shape.
type SummaryRow = Omit<QoderAccountDetail, 'enabled' | 'qoderUserIdMasked' | 'credits' | 'creditsUpdatedAt' | 'creditsError'> & {
  enabled: boolean | number;
  creditsJson?: string | null;
  credits?: QoderCredits | null;
  creditsUpdatedAt?: string | null;
  creditsError?: string | null;
};

export function toQoderAccountSummary(row: SummaryRow): QoderAccountSummary {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    qoderUserIdMasked: maskQoderValue(row.qoderUserId),
    // SQLite hands raw rows back as 0/1; the API contract (and the web UI) expects a boolean.
    enabled: Boolean(row.enabled),
    healthState: row.healthState,
    priority: row.priority,
    jobTokenExpiresAt: row.jobTokenExpiresAt,
    catalogFetchedAt: row.catalogFetchedAt,
    credits: (row.credits ?? null) || parseStoredCredits(row.creditsJson ?? null),
    creditsUpdatedAt: row.creditsUpdatedAt ?? null,
    creditsError: row.creditsError ?? null,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listQoderAccountSummaries(providerId: string): QoderAccountSummary[] {
  const rows = getRawDb()
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM qoder_accounts WHERE provider_id=? ORDER BY priority,id`)
    .all(providerId) as SummaryRow[];
  return rows.map(toQoderAccountSummary);
}

export function listQoderAccountsForProvider(providerId: string): QoderAccountDetail[] {
  const rows = getRawDb()
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM qoder_accounts WHERE provider_id=? ORDER BY priority,id`)
    .all(providerId) as SummaryRow[];
  return rows.map((row) => ({ ...toQoderAccountSummary(row), providerId: row.providerId, qoderUserId: row.qoderUserId, machineId: row.machineId }));
}

export function findEligibleQoderAccount(providerId: string): QoderAccountCandidate | null {
  const row = getRawDb()
    .prepare(
      `SELECT id,qoder_user_id AS qoderUserId,enabled,health_state AS healthState,priority
       FROM qoder_accounts WHERE provider_id=? AND enabled=1 AND health_state<>'down'
       ORDER BY priority,id LIMIT 1`,
    )
    .get(providerId) as { id: string; qoderUserId: string; enabled: number; healthState: string; priority: number } | undefined;
  if (!row) return null;
  return { id: row.id, qoderUserId: row.qoderUserId, enabled: Boolean(row.enabled), healthState: row.healthState, priority: row.priority };
}

/**
 * Match an imported PAT against existing rows. The PAT is the identity: the same token re-imported
 * must update its account rather than create a duplicate. Rows are compared by decrypting each
 * stored PAT (a handful at most) because the plaintext digest cannot be stored — that would make
 * the token recoverable from the database.
 */
export function findQoderAccountForImport(providerId: string, personalToken: string): string | null {
  const target = createHash('sha256').update(personalToken, 'utf8').digest('hex');
  const rows = getRawDb().prepare('SELECT id FROM qoder_accounts WHERE provider_id=?').all(providerId) as Array<{ id: string }>;
  for (const row of rows) {
    const digest = createHash('sha256').update(getQoderCredentials(row.id).personalToken, 'utf8').digest('hex');
    if (digest === target) return row.id;
  }
  return null;
}

export function getQoderCredentials(id: string): DecryptedQoderCredentials {
  const row = getRawDb()
    .prepare(
      'SELECT encrypted_pat, pat_nonce, pat_version, encrypted_job_token, job_token_nonce, job_token_version, job_token_expires_at AS jobTokenExpiresAt FROM qoder_accounts WHERE id=?',
    )
    .get(id) as Record<string, string | number | null> | undefined;
  if (!row) throw new Error('Qoder account not found');
  return {
    personalToken: decryptSecret({ ciphertext: row.encrypted_pat as string, nonce: row.pat_nonce as string, version: row.pat_version as number }),
    jobToken: decryptSecret({ ciphertext: row.encrypted_job_token as string, nonce: row.job_token_nonce as string, version: row.job_token_version as number }),
    jobTokenExpiresAt: row.jobTokenExpiresAt as string,
  };
}

export function getQoderAccountRefreshState(id: string): { jobTokenExpiresAt: string } | null {
  const row = getRawDb().prepare('SELECT job_token_expires_at AS jobTokenExpiresAt FROM qoder_accounts WHERE id=?').get(id) as
    | { jobTokenExpiresAt: string }
    | undefined;
  return row ?? null;
}

/** Identity of one account by its own id (the pool-wide lookups are keyed by provider). */
export function getQoderAccountDetailById(id: string): QoderAccountDetail | null {
  const row = getRawDb().prepare(`SELECT ${SUMMARY_COLUMNS} FROM qoder_accounts WHERE id=?`).get(id) as SummaryRow | undefined;
  return row ? { ...toQoderAccountSummary(row), providerId: row.providerId, qoderUserId: row.qoderUserId, machineId: row.machineId } : null;
}

function persistQoderAccount(providerId: string, record: NormalizedQoderRecord, existingId?: string): string {
  const raw = getRawDb();
  const pat = encryptSecret(record.personalToken);
  const jobToken = encryptSecret(record.jobToken);
  const now = existingId ? nextUpdatedAt(existingId) : new Date().toISOString();
  const transaction = raw.transaction(() => {
    if (existingId) {
      raw
        .prepare(
          `UPDATE qoder_accounts SET email=?, label=?, machine_id=?, encrypted_pat=?, pat_nonce=?, pat_version=?,
           encrypted_job_token=?, job_token_nonce=?, job_token_version=?, job_token_expires_at=?,
           last_error=NULL, consecutive_failures=0, health_state='unknown', updated_at=? WHERE id=?`,
        )
        .run(
          record.email, record.label, record.machineId, pat.ciphertext, pat.nonce, pat.version,
          jobToken.ciphertext, jobToken.nonce, jobToken.version, record.jobTokenExpiresAt, now, existingId,
        );
      return existingId;
    }
    const priority = (raw.prepare('SELECT COALESCE(MAX(priority), -1) AS value FROM qoder_accounts WHERE provider_id=?').get(providerId) as { value: number }).value + 1;
    const id = uuid();
    raw
      .prepare(
        `INSERT INTO qoder_accounts (id, provider_id, email, label, qoder_user_id, machine_id, encrypted_pat, pat_nonce, pat_version,
         encrypted_job_token, job_token_nonce, job_token_version, job_token_expires_at, priority)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, providerId, record.email, record.label, record.qoderUserId, record.machineId,
        pat.ciphertext, pat.nonce, pat.version, jobToken.ciphertext, jobToken.nonce, jobToken.version, record.jobTokenExpiresAt, priority,
      );
    return id;
  });
  return transaction();
}

export function insertQoderAccount(providerId: string, record: NormalizedQoderRecord): string {
  return persistQoderAccount(providerId, record);
}

export function upsertQoderAccount(providerId: string, record: NormalizedQoderRecord): { id: string; status: 'inserted' | 'updated' } {
  const existing = getRawDb()
    .prepare('SELECT id FROM qoder_accounts WHERE provider_id=? AND qoder_user_id=?')
    .get(providerId, record.qoderUserId) as { id: string } | undefined;
  if (!existing) return { id: persistQoderAccount(providerId, record), status: 'inserted' };
  return { id: persistQoderAccount(providerId, record, existing.id), status: 'updated' };
}

export function persistQoderJobToken(
  id: string,
  update: { jobToken: string; expiresAt: string; catalogJson?: string | null; catalogFetchedAt?: string | null },
): void {
  const jobToken = encryptSecret(update.jobToken);
  getRawDb()
    .prepare(
      `UPDATE qoder_accounts SET encrypted_job_token=?, job_token_nonce=?, job_token_version=?, job_token_expires_at=?,
       catalog_json=COALESCE(?, catalog_json), catalog_fetched_at=COALESCE(?, catalog_fetched_at),
       health_state='healthy', last_error=NULL, updated_at=? WHERE id=?`,
    )
    .run(
      jobToken.ciphertext, jobToken.nonce, jobToken.version, update.expiresAt,
      update.catalogJson ?? null, update.catalogFetchedAt ?? null, nextUpdatedAt(id), id,
    );
}

/** `enabled` mirrors the Codex setter: pass `false` to take an exhausted account out of the pool. */
export function setQoderAccountHealth(id: string, healthState: string, lastError: string | null = null, enabled?: boolean): void {
  const failures = healthState === 'healthy' ? 0 : null;
  const fields = enabled === undefined
    ? 'health_state=?, last_error=?, consecutive_failures=COALESCE(?, consecutive_failures), updated_at=?'
    : 'health_state=?, last_error=?, consecutive_failures=COALESCE(?, consecutive_failures), enabled=?, updated_at=?';
  const values = enabled === undefined
    ? [healthState, lastError, failures, nextUpdatedAt(id), id]
    : [healthState, lastError, failures, enabled ? 1 : 0, nextUpdatedAt(id), id];
  getRawDb().prepare(`UPDATE qoder_accounts SET ${fields} WHERE id=?`).run(...values);
}

export function readQoderCatalog(id: string): { catalogJson: string | null; catalogFetchedAt: string | null } | null {
  const row = getRawDb()
    .prepare('SELECT catalog_json AS catalogJson, catalog_fetched_at AS catalogFetchedAt FROM qoder_accounts WHERE id=?')
    .get(id) as { catalogJson: string | null; catalogFetchedAt: string | null } | undefined;
  return row ?? null;
}

export function saveQoderCatalog(id: string, catalogJson: string, fetchedAt?: string | null): void {
  getRawDb()
    .prepare('UPDATE qoder_accounts SET catalog_json=?, catalog_fetched_at=?, updated_at=? WHERE id=?')
    .run(catalogJson, fetchedAt ?? new Date().toISOString(), nextUpdatedAt(id), id);
}

/** When the Credits snapshot was last written; null when it never has been. */
export function readQoderCreditsUpdatedAt(id: string): string | null {
  const row = getRawDb().prepare('SELECT credits_updated_at AS at FROM qoder_accounts WHERE id=?').get(id) as { at: string | null } | undefined;
  return row?.at ?? null;
}

/** Credits are observability, not routing state: a failed fetch is recorded without touching health. */
export function saveQoderCredits(id: string, creditsJson: string | null, error: string | null, fetchedAt: string): void {
  getRawDb()
    .prepare('UPDATE qoder_accounts SET credits_json=COALESCE(?, credits_json), credits_updated_at=?, credits_error=?, updated_at=? WHERE id=?')
    .run(creditsJson, fetchedAt, error, nextUpdatedAt(id), id);
}

// Keeps `updated_at` strictly increasing even within the same millisecond, so a caller can
// detect a write it just made. Copied from the Codex repository for consistency.
function nextUpdatedAt(id: string): string {
  const current = getRawDb().prepare('SELECT updated_at AS updatedAt FROM qoder_accounts WHERE id=?').get(id) as { updatedAt: string } | undefined;
  const now = Date.now();
  const previous = current ? Date.parse(current.updatedAt) : 0;
  return new Date(Math.max(now, previous + 1)).toISOString();
}
