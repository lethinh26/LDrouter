// Admin API: database backup / restore.

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { getDb } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { loadConfig } from '../../config/index';
import { getSettings } from '../../db/repositories/settings';
import { GatewayError } from '../../errors';

const BACKUP_VERSION = 1;
const APP_VERSION = '0.1.0';

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
      appVersion: APP_VERSION,
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
    // Snapshot current DB before restore
    const db = getDb();
    void db;
    const snapshot = path.join(cfg.dataDir, `pre-restore-${Date.now()}.sqlite`);
    const Database = (await import('better-sqlite3')).default;
    const live = new Database(cfg.dbFile);
    try {
      await live.backup(snapshot);
    } catch (e) {
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'snapshot_failed', err: String(e) } });
      throw new GatewayError('gateway_error', 'Could not snapshot current database', { status: 500 });
    }
    // Atomic replace
    const liveDb = cfg.dbFile;
    const tempDb = `${liveDb}.restore-${Date.now()}`;
    fs.writeFileSync(tempDb, buf);
    try {
      fs.renameSync(tempDb, liveDb);
    } catch (e) {
      fs.unlinkSync(tempDb);
      recordAudit({ action: 'db.restore', success: false, ip: req.ip, metadata: { reason: 'rename_failed', err: String(e) } });
      throw new GatewayError('gateway_error', 'Restore atomic replace failed', { status: 500 });
    }
    recordAudit({ action: 'db.restore', success: true, ip: req.ip, metadata: { schemaVersion: envelope.schemaVersion } });
    return reply.code(200).send({ ok: true, message: 'Restore completed. Please restart the gateway for changes to take effect.' });
  });
}
