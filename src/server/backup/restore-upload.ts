// Streamed, disk-based backup restore support.
//
// The upload is written straight to a private temp file (never buffered in memory), the v2 header
// is read from disk, and the payload is stream-decompressed into a second temp SQLite file that is
// validated (magic, integrity_check, manifest checksum, key envelope, schema version) BEFORE the
// caller swaps it in. Every failure path removes its temp files.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { loadConfig, type RuntimeConfig } from '../config/index';
import { GatewayError } from '../errors';
import { decryptBackupMasterKey } from '../auth/backup-crypto';
import { parseMasterKey } from '../auth/crypto';
import { getSettings } from '../db/repositories/settings';
import {
  readBackupContainerHeader,
  streamBackupPayload,
  type BackupProfile,
} from './container';

/** Tables a compact export must have left in place; a restore of one without them is not usable. */
const COMPACT_AGGREGATE_TABLES = ['daily_model_stats', 'daily_provider_stats', 'daily_api_key_stats'];

/** Ceiling on decompressed bytes, as a multiple of the configured upload limit. A SQLite snapshot
 *  compresses ~3-10x, so 20x is generous while still bounding a decompression bomb. */
const MAX_UNCOMPRESSED_MULTIPLE = 20;

const LEGACY_VERSION = 1;

export interface UploadedBackup {
  /** Private temp file holding the raw upload. */
  path: string;
  bytes: number;
  /** Original client filename; selects the v2 binary or legacy v1 JSON reader. */
  filename: string;
  /** Optional six-digit passphrase collected from the same multipart body. */
  passphrase?: string;
  cleanup(): Promise<void>;
}

export interface ValidatedBackup {
  /** Private temp SQLite file, ready to swap in. */
  sqlitePath: string;
  schemaVersion: number;
  profile: BackupProfile;
  /** Decrypted master key when the backup carried a key envelope. */
  masterKey?: Buffer;
  cleanup(): Promise<void>;
}

interface LegacyEnvelope {
  format?: string;
  version?: number;
  schemaVersion?: number;
  payload?: string;
  checksum?: string;
  keyEnvelope?: Parameters<typeof decryptBackupMasterKey>[0];
}

function backupError(code: string, message: string, status = 400): GatewayError {
  return new GatewayError('invalid_request_error', message, { status, code });
}

const tooLarge = () => backupError('backup_too_large', 'Backup upload exceeds maximum size', 413);
const malformed = () => backupError('multipart_malformed', 'Malformed multipart restore body');
const invalidFormat = () => backupError('invalid_backup_format', 'Invalid backup file format');
const checksumMismatch = () => backupError('checksum_mismatch', 'Backup checksum mismatch');
const decompressFailed = () => backupError('decompress_failed', 'Backup decompression failed');
const notSqlite = () => backupError('not_sqlite', 'Backup does not contain a valid SQLite database');
const integrityFailed = () => backupError('integrity_failed', 'Backup database failed the integrity check');
const invalidPassphrase = () => backupError('invalid_backup_passphrase', 'Invalid backup passphrase');

async function restoreTmpDir(cfg: RuntimeConfig): Promise<string> {
  const dir = path.join(cfg.dataDir, 'restore-tmp');
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function removeQuietly(...files: string[]): void {
  for (const file of files) fs.rmSync(file, { force: true });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of stream) void chunk;
}

/**
 * Collect the single `backup` file part into `<dataDir>/restore-tmp/<uuid>.part` (dir 0700, file
 * 0600), counting bytes as they arrive so the configured maximum is enforced mid-stream rather
 * than trusted from Content-Length alone.
 */
export async function receiveBackupUpload(
  request: FastifyRequest,
  options: { cfg: RuntimeConfig; maxBytes: number },
): Promise<UploadedBackup> {
  const maxBytes = options.maxBytes;
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const tmpDir = await restoreTmpDir(options.cfg);
  let target: string | undefined;
  let out: fs.WriteStream | undefined;
  let bytes = 0;
  let fileDone = false;
  let settled = false;
  let passphrase: string | undefined;
  let filename: string | undefined;

  // Abort/cancel cleanup: the request may die while the body is still streaming. Node also emits
  // 'close' when a request completes normally, so only an incomplete message counts as a cancel.
  const cleanupFile = () => {
    try { out?.destroy(); } catch { /* already gone */ }
    if (target) removeQuietly(target);
  };
  const onAbort = () => {
    if (settled || fileDone || request.raw.complete) return;
    settled = true;
    cleanupFile();
  };
  request.raw.once('aborted', onAbort);
  request.raw.once('close', onAbort);

  try {
    let seenFiles = 0;
    // The global multipart fileSize cap (2 MB, sized for JSON imports) is too small for a backup,
    // so the limit is raised per request here; the byte counter below is the real enforcement.
    for await (const part of request.parts({ limits: { fileSize: maxBytes + 1 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'passphrase') passphrase = String(part.value);
        continue;
      }
      if (part.fieldname !== 'backup') {
        await drain(part.file);
        throw malformed();
      }
      seenFiles += 1;
      if (seenFiles > 1) {
        await drain(part.file);
        throw malformed();
      }
      const name = part.filename ?? '';
      if (!name) {
        await drain(part.file);
        throw malformed();
      }
      if (!name.endsWith('.ldb') && !name.endsWith('.ldb.json')) {
        await drain(part.file);
        throw malformed();
      }
      filename = name;
      target = path.join(tmpDir, `${crypto.randomUUID()}.part`);
      out = fs.createWriteStream(target, { mode: 0o600, flags: 'wx' });
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(tooLarge());
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(part.file, counter, out);
      fileDone = true;
    }

    if (!target || !filename) throw malformed();
    settled = true;
    request.raw.off('aborted', onAbort);
    request.raw.off('close', onAbort);
    const filePath = target;
    return {
      path: filePath,
      bytes,
      filename,
      ...(passphrase === undefined ? {} : { passphrase }),
      cleanup: async () => { removeQuietly(filePath); },
    };
  } catch (error) {
    settled = true;
    cleanupFile();
    if (error instanceof GatewayError) throw error;
    throw malformed();
  }
}

/** Write a legacy v1 JSON envelope to a private temp file so both restore paths share one reader. */
export async function writeLegacyEnvelopeUpload(
  envelope: unknown,
  cfg: RuntimeConfig,
  passphrase?: string,
): Promise<UploadedBackup> {
  const tmpDir = await restoreTmpDir(cfg);
  const target = path.join(tmpDir, `${crypto.randomUUID()}.ldb.json`);
  const body = Buffer.from(JSON.stringify(envelope ?? {}), 'utf8');
  if (body.length > cfg.maxBackupUploadBytes) throw tooLarge();
  await fs.promises.writeFile(target, body, { mode: 0o600 });
  return {
    path: target,
    bytes: body.length,
    filename: 'restore.ldb.json',
    ...(passphrase === undefined ? {} : { passphrase }),
    cleanup: async () => { removeQuietly(target); },
  };
}

/**
 * Validate an uploaded backup from disk and return a SQLite file ready for the atomic swap.
 * Reads only the v2 header into memory; the payload is streamed through gunzip into a second
 * private temp file. Nothing is swapped until checksum, decompression, SQLite integrity, schema
 * version, and the passphrase-protected key envelope have all passed.
 */
export async function validateUploadedBackup(upload: UploadedBackup, passphrase?: string): Promise<ValidatedBackup> {
  const cfg = loadConfig();
  const isLegacy = upload.filename.endsWith('.ldb.json');
  const sqlitePath = path.join(path.dirname(upload.path), `${crypto.randomUUID()}.sqlite`);
  const cleanup = async () => {
    removeQuietly(sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`, upload.path);
  };
  try {
    const result = isLegacy
      ? await validateLegacyJson(upload.path, sqlitePath, cfg, passphrase)
      : await validateV2(upload.path, sqlitePath, cfg, passphrase);
    return { ...result, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function validateV2(
  file: string,
  sqlitePath: string,
  cfg: RuntimeConfig,
  passphrase: string | undefined,
): Promise<Omit<ValidatedBackup, 'cleanup'>> {
  let manifest;
  let payloadOffset: number;
  try {
    ({ manifest, payloadOffset } = await readBackupContainerHeader(file));
  } catch {
    throw invalidFormat();
  }
  if (manifest.schemaVersion > getSettings().schemaVersion) {
    throw backupError('future_schema', 'Backup was created by a newer schema version than this gateway supports');
  }

  const checksum = crypto.createHash('sha256');
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  const ceiling = cfg.maxBackupUploadBytes * MAX_UNCOMPRESSED_MULTIPLE;
  try {
    await pipeline(
      streamBackupPayload(file, payloadOffset),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          compressedBytes += chunk.length;
          checksum.update(chunk);
          callback(null, chunk);
        },
      }),
      zlib.createGunzip(),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          uncompressedBytes += chunk.length;
          if (uncompressedBytes > ceiling) {
            callback(tooLarge());
            return;
          }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(sqlitePath, { mode: 0o600, flags: 'wx' }),
    );
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw decompressFailed();
  }
  if (compressedBytes !== manifest.compressedBytes || checksum.digest('hex') !== manifest.checksum) {
    throw checksumMismatch();
  }

  await assertUsableSqlite(sqlitePath, manifest.profile);
  return {
    sqlitePath,
    schemaVersion: manifest.schemaVersion,
    profile: manifest.profile,
    ...(manifest.keyEnvelope ? { masterKey: decryptMasterKey(manifest.keyEnvelope, passphrase) } : {}),
  };
}

async function validateLegacyJson(
  file: string,
  sqlitePath: string,
  cfg: RuntimeConfig,
  passphrase: string | undefined,
): Promise<Omit<ValidatedBackup, 'cleanup'>> {
  // Bounded read: the file was already capped at the configured maximum by the receiver.
  let envelope: LegacyEnvelope;
  try {
    envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacyEnvelope;
  } catch {
    throw invalidFormat();
  }
  if (!envelope || envelope.format !== 'latedev-backup') throw invalidFormat();
  if (typeof envelope.version === 'number' && envelope.version > LEGACY_VERSION) {
    throw backupError('unsupported_version', 'Backup version is not supported');
  }
  const compressed = Buffer.from(String(envelope.payload ?? ''), 'base64');
  if (compressed.length > cfg.maxBackupUploadBytes) throw tooLarge();
  if (crypto.createHash('sha256').update(compressed).digest('hex') !== envelope.checksum) throw checksumMismatch();

  let uncompressedBytes = 0;
  const ceiling = cfg.maxBackupUploadBytes * MAX_UNCOMPRESSED_MULTIPLE;
  try {
    await pipeline(
      Readable.from(compressed),
      zlib.createGunzip(),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          uncompressedBytes += chunk.length;
          if (uncompressedBytes > ceiling) {
            callback(tooLarge());
            return;
          }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(sqlitePath, { mode: 0o600, flags: 'wx' }),
    );
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw decompressFailed();
  }

  await assertUsableSqlite(sqlitePath, 'full');
  return {
    sqlitePath,
    schemaVersion: typeof envelope.schemaVersion === 'number' ? envelope.schemaVersion : getSettings().schemaVersion,
    profile: 'full',
    ...(envelope.keyEnvelope ? { masterKey: decryptMasterKey(envelope.keyEnvelope, passphrase) } : {}),
  };
}

function decryptMasterKey(envelope: Parameters<typeof decryptBackupMasterKey>[0], passphrase: string | undefined): Buffer {
  if (!/^\d{6}$/.test(passphrase ?? '')) throw invalidPassphrase();
  let key: Buffer;
  try {
    key = decryptBackupMasterKey(envelope, passphrase!);
    parseMasterKey(key.toString('base64'));
  } catch {
    throw invalidPassphrase();
  }
  return key;
}

/** Verify the SQLite header, run a read-only integrity check, and confirm the tables the profile
 *  promises are actually present. */
async function assertUsableSqlite(file: string, profile: BackupProfile): Promise<void> {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.readSync(fd, head, 0, 16, 0) !== 16 || head.toString('utf8') !== 'SQLite format 3\u0000') throw notSqlite();
  } finally {
    fs.closeSync(fd);
  }

  const Database = (await import('better-sqlite3')).default;
  let db: import('better-sqlite3').Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (result?.integrity_check !== 'ok') throw integrityFailed();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name),
    );
    if (!tables.has('app_settings')) throw invalidFormat();
    if (profile === 'compact' && !COMPACT_AGGREGATE_TABLES.every((table) => tables.has(table))) throw invalidFormat();
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw notSqlite();
  } finally {
    db?.close();
  }
}
