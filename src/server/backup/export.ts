// Compact/full backup export: consistent snapshot → profile pruning → streamed gzip → v2 container.
// The SQLite payload is never read into memory: only per-chunk byte counters and the SHA-256
// digest state are kept while the snapshot is piped through gzip to disk.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RuntimeConfig } from '../config/index';
import { encryptBackupMasterKey } from '../auth/backup-crypto';
import { parseMasterKey } from '../auth/crypto';
import { getSettings } from '../db/repositories/settings';
import { getAppVersion } from '../version';
import { writeBackupContainer, type BackupManifestV2, type BackupProfile } from './container';

/** Forensic/volatile tables removed by a compact export; retained by a full export. */
export const COMPACT_EXCLUDED_TABLES = [
  'requests',
  'request_attempts',
  'audit_logs',
  'response_cache',
  'admin_sessions',
  'csrf_tokens',
  'backups',
] as const;

export async function createBackupExport(input: {
  profile: BackupProfile;
  passphrase: string;
  cfg: RuntimeConfig;
}): Promise<{ manifest: BackupManifestV2; body: Readable }> {
  const { profile, passphrase, cfg } = input;
  const snapshotFile = path.join(cfg.dataDir, `.export-snapshot-${crypto.randomUUID()}.sqlite`);
  const gzFile = path.join(cfg.dataDir, `.export-payload-${crypto.randomUUID()}.gz`);
  let body: Readable | undefined;
  try {
    const Database = (await import('better-sqlite3')).default;

    // 1. Consistent snapshot of the live DB while the gateway keeps serving.
    const source = new Database(cfg.dbFile, { readonly: true });
    try {
      await source.backup(snapshotFile);
    } finally {
      source.close();
    }

    // 2. Compact prunes the snapshot in place, then reclaims its pages. Full keeps every row.
    if (profile === 'compact') {
      const staging = new Database(snapshotFile);
      try {
        const present = new Set(
          (staging.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name),
        );
        for (const table of COMPACT_EXCLUDED_TABLES) {
          if (present.has(table)) staging.prepare(`DELETE FROM "${table}"`).run();
        }
        staging.exec('VACUUM');
      } finally {
        staging.close();
      }
    }

    // 3. Stream the snapshot through gzip to disk, hashing exactly the compressed bytes.
    const checksum = crypto.createHash('sha256');
    let uncompressedBytes = 0;
    let compressedBytes = 0;
    const meter = (onChunk: (length: number, chunk: Buffer) => void) =>
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          onChunk(chunk.length, chunk);
          callback(null, chunk);
        },
      });
    await pipeline(
      fs.createReadStream(snapshotFile),
      meter((length) => { uncompressedBytes += length; }),
      zlib.createGzip({ level: 6 }),
      meter((length, chunk) => { compressedBytes += length; checksum.update(chunk); }),
      fs.createWriteStream(gzFile),
    );

    // 4. v2 manifest.
    const masterKey = parseMasterKey(cfg.masterKey ?? fs.readFileSync(path.join(cfg.dataDir, 'master.key'), 'utf8').trim());
    const manifest: BackupManifestV2 = {
      format: 'latedev-backup',
      version: 2,
      profile,
      appVersion: getAppVersion(),
      schemaVersion: getSettings().schemaVersion,
      createdAt: new Date().toISOString(),
      compressedBytes,
      uncompressedBytes,
      checksum: checksum.digest('hex'),
      keyEnvelope: encryptBackupMasterKey(masterKey, passphrase),
      excludedTables: profile === 'compact' ? [...COMPACT_EXCLUDED_TABLES] : [],
      statistics: { granularity: 'daily', dimensions: ['model', 'provider', 'api_key'], p95Available: false },
    };

    // 5. Container. The payload stream is lazy, so the gz file must outlive this
    // function: it is deleted when that stream closes or errors, never before.
    body = await writeBackupContainer({ manifest, payload: fs.createReadStream(gzFile) });
    return { manifest, body };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${snapshotFile}${suffix}`, { force: true });
    if (body) {
      const removePayload = () => fs.rmSync(gzFile, { force: true });
      body.once('close', removePayload);
      body.once('error', removePayload);
    } else {
      fs.rmSync(gzFile, { force: true });
    }
  }
}
