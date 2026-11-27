// Admin API: database backup / restore.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, closeDb, openDb, schema } from '../../db/index';
import { requireAdminAuth, requireAdminCsrf } from '../../auth/middleware';
import { sha256Hex } from '../../auth/ids';
import { recordAudit } from '../../db/repositories/audit';
import { loadConfig, setConfigMasterKey } from '../../config/index';
import { getSettings } from '../../db/repositories/settings';
import { GatewayError } from '../../errors';
import { eq, sql } from 'drizzle-orm';
import type { BackupMasterKeyEnvelope } from '../../auth/backup-crypto';
import { resetMasterKeyCache } from '../../auth/crypto';
import { createBackupExport } from '../../backup/export';
import type { BackupProfile } from '../../backup/container';
import { receiveBackupUpload, validateUploadedBackup, writeLegacyEnvelopeUpload, type ValidatedBackup } from '../../backup/restore-upload';

interface BackupEnvelope {
  format: 'latedev-backup';
  version: number;
  appVersion: string;
  schemaVersion: number;
  masterKeyConfigured: boolean;
  createdAt: string;
  payload: string; // base64 gzipped sqlite
  checksum: string;
  keyEnvelope?: BackupMasterKeyEnvelope;
}

interface RestoreResult {
  profile: BackupProfile;
  message: string;
}

/** Reopen the in-process SQLite connection on the (possibly just-replaced)
 *  database file. The old connection must already be closed: a hot restore
 *  swaps the file on disk, then the gateway keeps serving from the new data
 *  without a restart. Schema migrations and the app_settings bootstrap run
 *  automatically on open. */
function reopenDatabase(dbFile: string): void {
  const dir = path.dirname(dbFile);
  const base = path.basename(dbFile);

  // When the WAL is in non-persistent mode, SQLite keeps `data.sqlite-wal`
  // and `data.sqlite-shm` next to the DB. After we replace the DB file the
  // OLD wal/shm describe the PREVIOUS database — replaying them would
  // resurrect the old data over the restored snapshot (the gateway looked
  // like "nothing was restored"). They are safe to delete: the old
  // connection is closed (wal fully checkpointed) and the restored backup is
  // a consistent standalone snapshot.
  for (const suffix of ['-wal', '-shm']) {
    const stale = path.join(dir, `${base}${suffix}`);
    try {
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    } catch {
      /* ignore: unlink failure is not fatal, next restart would retry */
    }
  }

  openDb(dbFile);
}

/** Verify the current database (as restored) is consistent: matches the
 *  schema version we expect and has the bootstrap app_settings row. */
function assertDatabaseUsable(expectedSchemaVersion: number): void {
  const db = getDb();
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.id, 1)).get();
  if (!row) throw new Error('restored database is missing the app_settings bootstrap row');
  if (row.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`restored database schema version mismatch: expected ${expectedSchemaVersion}, got ${row.schemaVersion}`);
  }
}

/** Raw filesystem/multipart failures become safe fixed-message errors; validated
 *  failures keep their own safe GatewayError. Internal paths never reach the browser. */
function safeRestoreError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError('gateway_error', 'Restore failed', { status: 500 });
}

function auditRestoreFailure(req: FastifyRequest, error: unknown): void {
  const reason = error instanceof GatewayError ? (error.code ?? error.type) : 'restore_error';
  recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason } });
}

/** Accept both the wrapped `{ backup, passphrase }` legacy body and the bare envelope. */
function legacyRequestBody(body: unknown): { envelope: BackupEnvelope | undefined; passphrase?: string } {
  const incoming = body as { backup?: BackupEnvelope; passphrase?: string } | BackupEnvelope | undefined;
  const wrapped = Boolean(incoming && typeof incoming === 'object' && 'backup' in incoming);
  const wrappedBody = incoming as { backup?: BackupEnvelope; passphrase?: string };
  return { envelope: (wrapped ? wrappedBody.backup : incoming) as BackupEnvelope | undefined, passphrase: wrapped ? wrappedBody.passphrase : undefined };
}

/**
 * Atomic swap of an already-validated restore payload. Both the v2 multipart path and the legacy
 * v1 JSON path feed this, so the snapshot/rollback, hot reopen, session/CSRF re-seed, and audit
 * behaviour stay identical regardless of container format.
 */
export async function restoreValidatedDatabase(validated: ValidatedBackup, req: FastifyRequest): Promise<RestoreResult> {
  const cfg = loadConfig();
  const liveDb = cfg.dbFile;
  const previousMasterKey = cfg.masterKey;
  const restoreKeyPath = path.join(cfg.dataDir, 'master.key.restore');
  const previousRestoreKey = fs.existsSync(restoreKeyPath) ? fs.readFileSync(restoreKeyPath) : null;
  const restoredKey = validated.masterKey?.toString('base64');

  // Snapshot current DB before restore (kept for manual rollback).
  const snapshot = path.join(cfg.dataDir, `pre-restore-${Date.now()}.sqlite`);
  const Database = (await import('better-sqlite3')).default;
  const live = new Database(liveDb);
  try {
    await live.backup(snapshot);
  } catch {
    live.close();
    recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'snapshot_failed' } });
    throw new GatewayError('gateway_error', 'Could not snapshot current database', { status: 500 });
  }
  live.close();

  // Close the in-process connection before swapping the file. The gateway
  // keeps serving (no restart) but the file must be free: on Windows a
  // rename fails while a handle is open. Reopening runs migrations + the
  // app_settings bootstrap automatically.
  getDb();
  closeDb();

  // Atomic replace.
  const tempDb = `${liveDb}.restore-${Date.now()}`;
  fs.copyFileSync(validated.sqlitePath, tempDb);
  try {
    fs.renameSync(tempDb, liveDb);
  } catch {
    fs.rmSync(tempDb, { force: true });
    recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'rename_failed' } });
    throw new GatewayError('gateway_error', 'Restore atomic replace failed', { status: 500 });
  }

  // The backup key is authoritative. Apply it before reopening the restored
  // database so every post-restore read uses the key that encrypted it.
  if (restoredKey) {
    fs.writeFileSync(restoreKeyPath, restoredKey, { mode: 0o600, encoding: 'utf8' });
    setConfigMasterKey(restoredKey);
    resetMasterKeyCache();
  }

  // Hot-reload the database in-process: reopen the replaced file, validate
  // it, and keep serving. No gateway restart needed.
  try {
    reopenDatabase(liveDb);
    assertDatabaseUsable(validated.schemaVersion);
  } catch (e) {
    // Roll back to the snapshot taken before the restore so the gateway
    // never stays on a broken database.
    try { closeDb(); } catch { /* ignore */ }
    try {
      for (const suffix of ['-wal', '-shm']) {
        const stale = path.join(path.dirname(liveDb), `${path.basename(liveDb)}${suffix}`);
        if (fs.existsSync(stale)) fs.unlinkSync(stale);
      }
      fs.copyFileSync(snapshot, liveDb);
      openDb(liveDb);
      try {
        if (previousRestoreKey) fs.writeFileSync(restoreKeyPath, previousRestoreKey, { mode: 0o600 });
        else fs.unlinkSync(restoreKeyPath);
      } catch { /* no prior override */ }
      if (previousMasterKey) setConfigMasterKey(previousMasterKey);
      resetMasterKeyCache();
    } catch (rollbackErr) {
      const err = (e as Error).message;
      const rerr = (rollbackErr as Error).message;
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'rollback_failed', err, rollbackErr: rerr } });
      throw new GatewayError('gateway_error', `Restore failed (${err}) and automatic rollback also failed (${rerr}). Please restart the gateway.`, { status: 500 });
    }
    recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'validation_failed', err: (e as Error).message } });
    throw new GatewayError('gateway_error', `Restore failed: ${(e as Error).message}`, { status: 500 });
  }

  // The swap invalidates the previous admin session (its row lived in the
  // old database). Re-create the current session in the restored database so
  // the admin stays logged in across the hot restore.
  const sessionToken = req.cookies['ld_session'];
  const sessionId = req.adminSessionId;
  if (sessionId && sessionToken) {
    const db = getDb();
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    db.delete(schema.adminSessions).where(sql`id = ${sessionId}`).run();
    db.insert(schema.adminSessions).values({
      id: sessionId,
      tokenDigest: sha256Hex(sessionToken),
      expiresAt,
      lastSeenAt: new Date().toISOString(),
      ip: req.ip,
    }).run();
    // Re-seed the CSRF token that was bound to the old session.
    const csrfRow = db.select().from(schema.csrfTokens).where(eq(schema.csrfTokens.sessionId, sessionId)).get();
    if (!csrfRow) {
      db.insert(schema.csrfTokens).values({
        id: crypto.randomUUID(),
        sessionId,
        token: crypto.randomBytes(32).toString('base64url'),
        expiresAt,
      }).run();
    }
  }

  recordAudit({ action: 'db.restore', success: true, ip: req.ip, metadata: { profile: validated.profile, schemaVersion: validated.schemaVersion } });
  return { profile: validated.profile, message: 'Database restored. The gateway continues running with the restored data — no restart needed.' };
}

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
  // This module is registered in its own scope (routes/admin.ts) precisely so this is the only
  // auth hook on the backup routes. A preHandler cannot cancel a later one, so the first-run
  // import exemption must not sit alongside another admin module's requireAdminAuth.
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/api/admin/backup/restore' && !getSettings().setupComplete) return;
    await requireAdminAuth(req, reply);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) await requireAdminCsrf(req);
  });

  /** UI preflight: the effective server-side maximum upload size. */
  app.get('/api/admin/backup/capabilities', async () => ({ maxUploadBytes: loadConfig().maxBackupUploadBytes }));

  app.post('/api/admin/backup/create', async (req, reply) => {
    const body = (req.body as { passphrase?: string; profile?: string } | undefined) ?? {};
    const passphrase = body.passphrase ?? '';
    if (!/^\d{6}$/.test(passphrase)) {
      throw new GatewayError('invalid_request_error', 'Backup passphrase must contain exactly six digits', { status: 400 });
    }
    const profile: BackupProfile = body.profile === 'full' ? 'full' : 'compact';
    const { manifest, body: payload } = await createBackupExport({ profile, passphrase, cfg: loadConfig() });
    const fileName = `latedev-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ldb`;
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${fileName}"`);
    recordAudit({
      action: 'db.backup_download',
      success: true,
      ip: req.ip,
      metadata: { profile, sizeBytes: manifest.compressedBytes, checksum: manifest.checksum, excludedTables: manifest.excludedTables },
    });
    return reply.send(payload);
  });

  app.post('/api/admin/backup/restore', async (req, reply) => {
    const cfg = loadConfig();
    const contentType = String(req.headers['content-type'] ?? '');
    let upload: Awaited<ReturnType<typeof receiveBackupUpload>>;
    try {
      if (contentType.includes('multipart/form-data')) {
        upload = await receiveBackupUpload(req, { cfg, maxBytes: cfg.maxBackupUploadBytes });
      } else {
        const { envelope, passphrase } = legacyRequestBody(req.body);
        upload = await writeLegacyEnvelopeUpload(envelope, cfg, passphrase);
      }
    } catch (error) {
      auditRestoreFailure(req, error);
      throw safeRestoreError(error);
    }

    let validated: ValidatedBackup | undefined;
    try {
      validated = await validateUploadedBackup(upload, upload.passphrase);
      const result = await restoreValidatedDatabase(validated, req);
      return reply.code(200).send({ ok: true, profile: result.profile, message: result.message });
    } catch (error) {
      auditRestoreFailure(req, error);
      throw safeRestoreError(error);
    } finally {
      // Temp upload + decompressed payload are removed on success, failure, and abort.
      await validated?.cleanup();
      await upload.cleanup();
    }
  });
}
