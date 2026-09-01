// Admin API: database backup / restore.

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { getDb, closeDb, openDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { sha256Hex } from '../../auth/ids';
import { recordAudit } from '../../db/repositories/audit';
import { loadConfig } from '../../config/index';
import { getSettings } from '../../db/repositories/settings';
import { GatewayError } from '../../errors';
import { getAppVersion } from '../../version';
import { eq, sql } from 'drizzle-orm';

const BACKUP_VERSION = 1;

interface BackupEnvelope {
  format: 'latedev-backup';
  version: number;
  appVersion: string;
  schemaVersion: number;
  masterKeyConfigured: boolean;
  createdAt: string;
  payload: string; // base64 gzipped sqlite
  checksum: string;
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

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.post('/api/admin/backup/create', async (req, reply) => {
    const cfg = loadConfig();
    const temp = path.join(cfg.dataDir, `.backup-${Date.now()}.sqlite`);
    const Database = (await import('better-sqlite3')).default;
    const source = new Database(cfg.dbFile, { readonly: true });
    try {
      await source.backup(temp);
    } finally {
      source.close();
    }
    const buf = fs.readFileSync(temp);
    fs.unlinkSync(temp);
    const compressed = zlib.gzipSync(buf, { level: 6 });
    const checksum = crypto.createHash('sha256').update(compressed).digest('hex');
    const settings = getSettings();
    const envelope: BackupEnvelope = {
      format: 'latedev-backup',
      version: BACKUP_VERSION,
      appVersion: getAppVersion(),
      schemaVersion: settings.schemaVersion,
      masterKeyConfigured: settings.masterKeyConfigured,
      createdAt: new Date().toISOString(),
      payload: compressed.toString('base64'),
      checksum,
    };
    const envBuf = Buffer.from(JSON.stringify(envelope), 'utf8');
    const fileName = `latedev-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ldb.json`;
    reply.header('content-type', 'application/json');
    reply.header('content-disposition', `attachment; filename="${fileName}"`);
    recordAudit({ action: 'db.backup_download', success: true, ip: req.ip, metadata: { sizeBytes: envBuf.length, checksum } });
    return reply.send(envBuf);
  });

  app.post('/api/admin/backup/restore', async (req, reply) => {
    const cfg = loadConfig();
    // Expect raw JSON envelope in body
    let envelope: BackupEnvelope;
    try {
      envelope = req.body as BackupEnvelope;
      if (!envelope || envelope.format !== 'latedev-backup') throw new Error('not a backup envelope');
    } catch {
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'invalid_envelope' } });
      throw new GatewayError('invalid_request_error', 'Invalid backup file format', { status: 400 });
    }
    if (envelope.version > BACKUP_VERSION) {
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'future_version', version: envelope.version } });
      throw new GatewayError('invalid_request_error', `Backup version ${envelope.version} is not supported (max ${BACKUP_VERSION})`, { status: 400 });
    }
    const compressed = Buffer.from(envelope.payload, 'base64');
    const checksum = crypto.createHash('sha256').update(compressed).digest('hex');
    if (checksum !== envelope.checksum) {
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'checksum_mismatch' } });
      throw new GatewayError('invalid_request_error', 'Backup checksum mismatch', { status: 400 });
    }
    let buf: Buffer;
    try {
      buf = zlib.gunzipSync(compressed);
    } catch {
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'decompress_failed' } });
      throw new GatewayError('invalid_request_error', 'Backup decompression failed', { status: 400 });
    }
    // Validate SQLite header
    if (!(buf[0] === 0x53 && buf[1] === 0x51 && buf[2] === 0x4c && buf[3] === 0x69 && buf[4] === 0x74 && buf[5] === 0x65)) {
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'not_sqlite' } });
      throw new GatewayError('invalid_request_error', 'Backup does not contain a valid SQLite database', { status: 400 });
    }
    const liveDb = cfg.dbFile;
    // Snapshot current DB before restore (kept for manual rollback).
    const snapshot = path.join(cfg.dataDir, `pre-restore-${Date.now()}.sqlite`);
    const Database = (await import('better-sqlite3')).default;
    const live = new Database(liveDb);
    try {
      await live.backup(snapshot);
    } catch (e) {
      live.close();
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'snapshot_failed', err: String(e) } });
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
    fs.writeFileSync(tempDb, buf);
    try {
      fs.renameSync(tempDb, liveDb);
    } catch (e) {
      fs.unlinkSync(tempDb);
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'rename_failed', err: String(e) } });
      throw new GatewayError('gateway_error', 'Restore atomic replace failed', { status: 500 });
    }

    // Hot-reload the database in-process: reopen the replaced file, validate
    // it, and keep serving. No gateway restart needed.
    try {
      reopenDatabase(liveDb);
      assertDatabaseUsable(envelope.schemaVersion);
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

    recordAudit({ action: 'db.restore', success: true, ip: req.ip, metadata: { schemaVersion: envelope.schemaVersion } });
    return reply.code(200).send({ ok: true, message: 'Database restored. The gateway continues running with the restored data — no restart needed.' });
  });
}
