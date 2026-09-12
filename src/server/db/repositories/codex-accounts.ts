import { createHash } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../auth/crypto';
import { uuid } from '../../auth/ids';
import { getRawDb } from '../index';
import { codexAccounts } from '../schema';
import type { NormalizedCodexRecord } from '../../providers/codex-import';

type AccountRow = typeof codexAccounts.$inferSelect;

export interface CodexIdentity {
  chatgptAccountId: string | null;
  workspaceId: string | null;
  email: string | null;
  tokenDigest: string;
}

export interface DecryptedCodexCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
}

export interface CodexAccountSummary {
  id: string;
  email: string | null;
  accountIdMasked: string | null;
  workspaceIdMasked: string | null;
  planType: string | null;
  tokenExpiresAt: string;
  enabled: boolean;
  healthState: AccountRow['healthState'];
  lastRefreshAt: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export function maskCodexValue(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 8 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function identityFromCodexRecord(record: NormalizedCodexRecord): CodexIdentity {
  return {
    chatgptAccountId: record.chatgptAccountId,
    workspaceId: record.workspaceId,
    email: record.email,
    tokenDigest: digest(record.accessToken),
  };
}

export function toCodexAccountSummary(row: Pick<AccountRow, 'id' | 'email' | 'workspaceId' | 'chatgptAccountId' | 'planType' | 'tokenExpiresAt' | 'enabled' | 'healthState' | 'lastRefreshAt' | 'priority' | 'createdAt' | 'updatedAt'>): CodexAccountSummary {
  return {
    id: row.id,
    email: row.email,
    accountIdMasked: maskCodexValue(row.chatgptAccountId),
    workspaceIdMasked: maskCodexValue(row.workspaceId),
    planType: row.planType,
    tokenExpiresAt: row.tokenExpiresAt,
    enabled: row.enabled,
    healthState: row.healthState,
    lastRefreshAt: row.lastRefreshAt,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const client = getRawDb;

function encrypted(value: string): { ciphertext: string; nonce: string; version: number } {
  return encryptSecret(value);
}

export function listCodexAccountsForProvider(providerId: string): Array<{ id: string; chatgptAccountId: string; enabled: boolean; healthState: AccountRow['healthState']; tokenExpiresAt: string; priority: number }> {
  return client().prepare(`SELECT id, chatgpt_account_id AS chatgptAccountId, enabled, health_state AS healthState, token_expires_at AS tokenExpiresAt, priority FROM codex_accounts WHERE provider_id=? ORDER BY priority,id`).all(providerId) as Array<{ id: string; chatgptAccountId: string; enabled: boolean; healthState: AccountRow['healthState']; tokenExpiresAt: string; priority: number }>;
}

export function getCodexAccountForProvider(providerId: string): { id: string; chatgptAccountId: string } | null {
  const row = listCodexAccountsForProvider(providerId).find((a) => a.enabled && (a.healthState === 'healthy' || a.healthState === 'unknown') && Date.parse(a.tokenExpiresAt) > Date.now());
  return row?.chatgptAccountId ? { id: row.id, chatgptAccountId: row.chatgptAccountId } : null;
}

export function getCodexAccountById(id: string): { id: string; chatgptAccountId: string } | null {
  const row = client().prepare(`SELECT id, chatgpt_account_id AS chatgptAccountId, enabled, health_state AS healthState, token_expires_at AS tokenExpiresAt FROM codex_accounts WHERE id=?`).get(id) as { id: string; chatgptAccountId: string | null; enabled: boolean; healthState: AccountRow['healthState']; tokenExpiresAt: string } | undefined;
  if (!row || !row.enabled || !['healthy', 'unknown'].includes(row.healthState) || Date.parse(row.tokenExpiresAt) <= Date.now()) return null;
  return row.chatgptAccountId ? { id: row.id, chatgptAccountId: row.chatgptAccountId } : null;
}

export function listCodexAccountSummaries(providerId: string): CodexAccountSummary[] {
  const rows = client().prepare(`SELECT id,email,workspace_id AS workspaceId,chatgpt_account_id AS chatgptAccountId,plan_type AS planType,token_expires_at AS tokenExpiresAt,enabled,health_state AS healthState,last_refresh_at AS lastRefreshAt,priority,created_at AS createdAt,updated_at AS updatedAt FROM codex_accounts WHERE provider_id=? ORDER BY priority,id`).all(providerId) as Array<Parameters<typeof toCodexAccountSummary>[0]>;
  return rows.map(toCodexAccountSummary);
}

export function findCodexAccountForImport(providerId: string, identity: CodexIdentity): AccountRow | null {
  const rows = client().prepare(`SELECT id,provider_id AS providerId,email,workspace_id AS workspaceId,chatgpt_account_id AS chatgptAccountId,plan_type AS planType,encrypted_access_token AS encryptedAccessToken,access_token_nonce AS accessTokenNonce,access_token_version AS accessTokenVersion,encrypted_refresh_token AS encryptedRefreshToken,refresh_token_nonce AS refreshTokenNonce,refresh_token_version AS refreshTokenVersion,encrypted_id_token AS encryptedIdToken,id_token_nonce AS idTokenNonce,id_token_version AS idTokenVersion,token_expires_at AS tokenExpiresAt,last_refresh_at AS lastRefreshAt,auth_method AS authMethod,enabled,health_state AS healthState,last_error AS lastError,consecutive_failures AS consecutiveFailures,priority,created_at AS createdAt,updated_at AS updatedAt FROM codex_accounts WHERE provider_id=?`).all(providerId) as AccountRow[];
  const providerRows = rows;
  if (identity.chatgptAccountId) {
    const account = providerRows.find((row) => row.chatgptAccountId === identity.chatgptAccountId);
    if (account) return account;
  }
  if (identity.workspaceId) {
    const workspace = providerRows.find((row) => row.workspaceId === identity.workspaceId);
    if (workspace) return workspace;
  }
  for (const row of providerRows) {
    const credentials = getCodexCredentials(row.id);
    if (digest(credentials.accessToken) === identity.tokenDigest) return row;
  }
  return null;
}

function persistImport(providerId: string, record: NormalizedCodexRecord, existingId?: string): string {
  const raw = client();
  const access = encrypted(record.accessToken);
  const refresh = encrypted(record.refreshToken);
  const idToken = record.idToken ? encrypted(record.idToken) : null;
  const now = existingId ? nextUpdatedAt(existingId) : new Date().toISOString();
  const transaction = raw.transaction(() => {
    if (existingId) {
      raw.prepare(`UPDATE codex_accounts SET email=?, workspace_id=?, chatgpt_account_id=?, plan_type=?, encrypted_access_token=?, access_token_nonce=?, access_token_version=?, encrypted_refresh_token=?, refresh_token_nonce=?, refresh_token_version=?, encrypted_id_token=?, id_token_nonce=?, id_token_version=?, token_expires_at=?, last_error=NULL, consecutive_failures=0, health_state='unknown', updated_at=? WHERE id=?`).run(
        record.email, record.workspaceId, record.chatgptAccountId, record.planType, access.ciphertext, access.nonce, access.version, refresh.ciphertext, refresh.nonce, refresh.version,
        idToken?.ciphertext ?? null, idToken?.nonce ?? null, idToken?.version ?? 1, record.expiresAt, now, existingId,
      );
      return existingId;
    }
    const priority = (raw.prepare('SELECT COALESCE(MAX(priority), -1) AS value FROM codex_accounts WHERE provider_id=?').get(providerId) as { value: number }).value + 1;
    const id = uuid();
    raw.prepare(`INSERT INTO codex_accounts (id, provider_id, email, workspace_id, chatgpt_account_id, plan_type, encrypted_access_token, access_token_nonce, access_token_version, encrypted_refresh_token, refresh_token_nonce, refresh_token_version, encrypted_id_token, id_token_nonce, id_token_version, token_expires_at, priority) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, providerId, record.email, record.workspaceId, record.chatgptAccountId, record.planType, access.ciphertext, access.nonce, access.version, refresh.ciphertext, refresh.nonce, refresh.version,
      idToken?.ciphertext ?? null, idToken?.nonce ?? null, idToken?.version ?? 1, record.expiresAt, priority,
    );
    return id;
  });
  return transaction();
}

export function insertCodexAccount(providerId: string, record: NormalizedCodexRecord): string {
  return persistImport(providerId, record);
}

export function updateCodexAccountFromImport(id: string, record: NormalizedCodexRecord): string {
  const row = client().prepare('SELECT provider_id FROM codex_accounts WHERE id=?').get(id) as { provider_id: string } | undefined;
  if (!row) throw new Error('Codex account not found');
  return persistImport(row.provider_id, record, id);
}

export function getCodexCredentials(id: string): DecryptedCodexCredentials {
  const row = client().prepare('SELECT encrypted_access_token, access_token_nonce, access_token_version, encrypted_refresh_token, refresh_token_nonce, refresh_token_version, encrypted_id_token, id_token_nonce, id_token_version FROM codex_accounts WHERE id=?').get(id) as Record<string, string | number | null> | undefined;
  if (!row) throw new Error('Codex account not found');
  return {
    accessToken: decryptSecret({ ciphertext: row.encrypted_access_token as string, nonce: row.access_token_nonce as string, version: row.access_token_version as number }),
    refreshToken: decryptSecret({ ciphertext: row.encrypted_refresh_token as string, nonce: row.refresh_token_nonce as string, version: row.refresh_token_version as number }),
    idToken: row.encrypted_id_token ? decryptSecret({ ciphertext: row.encrypted_id_token as string, nonce: row.id_token_nonce as string, version: row.id_token_version as number }) : null,
  };
}

export interface CodexAccountRefreshState {
  tokenExpiresAt: string;
  refreshToken: string;
  idToken: string | null;
}

export function getCodexAccountRefreshState(id: string): CodexAccountRefreshState | null {
  const row = client().prepare('SELECT token_expires_at AS tokenExpiresAt FROM codex_accounts WHERE id=?').get(id) as { tokenExpiresAt: string } | undefined;
  if (!row) return null;
  const credentials = getCodexCredentials(id);
  return { tokenExpiresAt: row.tokenExpiresAt, refreshToken: credentials.refreshToken, idToken: credentials.idToken };
}

export function persistCodexRefresh(id: string, update: { accessToken: string; refreshToken: string; idToken: string | null; expiresAt: string }): void {
  const access = encrypted(update.accessToken);
  const refresh = encrypted(update.refreshToken);
  const idToken = update.idToken ? encrypted(update.idToken) : null;
  const updatedAt = nextUpdatedAt(id);
  client().transaction(() => {
    client().prepare(`UPDATE codex_accounts SET encrypted_access_token=?, access_token_nonce=?, access_token_version=?, encrypted_refresh_token=?, refresh_token_nonce=?, refresh_token_version=?, encrypted_id_token=?, id_token_nonce=?, id_token_version=?, token_expires_at=?, last_refresh_at=?, last_error=NULL, consecutive_failures=0, health_state='healthy', updated_at=? WHERE id=?`).run(
      access.ciphertext, access.nonce, access.version, refresh.ciphertext, refresh.nonce, refresh.version,
      idToken?.ciphertext ?? null, idToken?.nonce ?? null, idToken?.version ?? 1, update.expiresAt, updatedAt, updatedAt, id,
    );
  })();
}

function nextUpdatedAt(id: string): string {
  const current = client().prepare('SELECT updated_at AS updatedAt FROM codex_accounts WHERE id=?').get(id) as { updatedAt: string } | undefined;
  const now = Date.now();
  const previous = current ? Date.parse(current.updatedAt) : 0;
  return new Date(Math.max(now, previous + 1)).toISOString();
}

export function setCodexAccountHealth(id: string, healthState: AccountRow['healthState'], lastError: string | null = null, enabled?: boolean): void {
  const fields = enabled === undefined ? 'health_state=?, last_error=?, updated_at=?' : 'health_state=?, last_error=?, enabled=?, updated_at=?';
  const updatedAt = nextUpdatedAt(id);
  const values = enabled === undefined ? [healthState, lastError, updatedAt, id] : [healthState, lastError, enabled ? 1 : 0, updatedAt, id];
  client().prepare(`UPDATE codex_accounts SET ${fields} WHERE id=?`).run(...values);
}

export function upsertCodexAccount(providerId: string, record: NormalizedCodexRecord): { id: string; status: 'added' | 'updated' } {
  const existing = findCodexAccountForImport(providerId, identityFromCodexRecord(record));
  return existing ? { id: updateCodexAccountFromImport(existing.id, record), status: 'updated' } : { id: insertCodexAccount(providerId, record), status: 'added' };
}
