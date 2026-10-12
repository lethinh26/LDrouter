import fs from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { BackupMasterKeyEnvelope } from '../auth/backup-crypto';

export const BACKUP_MAGIC = Buffer.from('LDRB');
export const BACKUP_VERSION = 2;
export const MAX_BACKUP_MANIFEST_BYTES = 1024 * 1024;

const PREFIX_BYTES = BACKUP_MAGIC.length + 1 + 4;

export type BackupProfile = 'compact' | 'full';

export interface BackupManifestV2 {
  format: 'latedev-backup';
  version: 2;
  profile: BackupProfile;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  compressedBytes: number;
  uncompressedBytes: number;
  checksum: string;
  keyEnvelope?: BackupMasterKeyEnvelope;
  excludedTables: string[];
  statistics: {
    granularity: 'daily';
    dimensions: Array<'model' | 'provider' | 'api_key'>;
    p95Available: false;
  };
}

export async function writeBackupContainer(input: { manifest: BackupManifestV2; payload: Readable }): Promise<Readable> {
  const manifest = Buffer.from(JSON.stringify(input.manifest), 'utf8');
  if (manifest.length > MAX_BACKUP_MANIFEST_BYTES) throw new Error('Backup manifest exceeds maximum size');

  const header = Buffer.alloc(PREFIX_BYTES + manifest.length);
  BACKUP_MAGIC.copy(header);
  header.writeUInt8(BACKUP_VERSION, BACKUP_MAGIC.length);
  header.writeUInt32BE(manifest.length, BACKUP_MAGIC.length + 1);
  manifest.copy(header, PREFIX_BYTES);

  return Readable.from((async function* () {
    yield header;
    yield* input.payload;
  })());
}

interface BackupHeaderReader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

type OpenBackupHeaderFile = (file: string) => Promise<BackupHeaderReader>;

export async function readBackupContainerHeader(
  file: string,
  open: OpenBackupHeaderFile = (path) => openFile(path, 'r'),
): Promise<{ manifest: BackupManifestV2; payloadOffset: number }> {
  const handle = await open(file);
  try {
    const prefix = Buffer.alloc(PREFIX_BYTES);
    const prefixRead = await handle.read(prefix, 0, PREFIX_BYTES, 0);
    if (prefixRead.bytesRead !== PREFIX_BYTES) throw new Error('Truncated backup header');
    if (!prefix.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error('Invalid backup magic');
    if (prefix.readUInt8(BACKUP_MAGIC.length) !== BACKUP_VERSION) throw new Error('Unsupported backup version');

    const manifestLength = prefix.readUInt32BE(BACKUP_MAGIC.length + 1);
    if (manifestLength > MAX_BACKUP_MANIFEST_BYTES) throw new Error('Backup manifest exceeds maximum size');
    const manifestBytes = Buffer.alloc(manifestLength);
    const manifestRead = await handle.read(manifestBytes, 0, manifestLength, PREFIX_BYTES);
    if (manifestRead.bytesRead !== manifestLength) throw new Error('Truncated backup header');

    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new Error('Invalid backup manifest');
    }
    if (!isBackupManifestV2(manifest)) throw new Error('Invalid backup manifest');
    return { manifest, payloadOffset: PREFIX_BYTES + manifestLength };
  } finally {
    await handle.close();
  }
}

export function streamBackupPayload(file: string, payloadOffset: number): Readable {
  return fs.createReadStream(file, { start: payloadOffset });
}


function isBackupManifestV2(value: unknown): value is BackupManifestV2 {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<BackupManifestV2>;
  return manifest.format === 'latedev-backup'
    && manifest.version === BACKUP_VERSION
    && (manifest.profile === 'compact' || manifest.profile === 'full')
    && typeof manifest.appVersion === 'string'
    && isNonNegativeInteger(manifest.schemaVersion)
    && isIsoTimestamp(manifest.createdAt)
    && isNonNegativeInteger(manifest.compressedBytes)
    && isNonNegativeInteger(manifest.uncompressedBytes)
    && typeof manifest.checksum === 'string'
    && /^[a-f\d]{64}$/i.test(manifest.checksum)
    && (!('keyEnvelope' in manifest) || isBackupMasterKeyEnvelope(manifest.keyEnvelope))
    && Array.isArray(manifest.excludedTables)
    && manifest.excludedTables.every((table) => typeof table === 'string')
    && !!manifest.statistics
    && manifest.statistics.granularity === 'daily'
    && manifest.statistics.p95Available === false
    && Array.isArray(manifest.statistics.dimensions)
    && manifest.statistics.dimensions.every((dimension) => dimension === 'model' || dimension === 'provider' || dimension === 'api_key');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function isBackupMasterKeyEnvelope(value: unknown): value is BackupMasterKeyEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<BackupMasterKeyEnvelope>;
  return envelope.algorithm === 'scrypt-aes-256-gcm'
    && typeof envelope.salt === 'string'
    && typeof envelope.nonce === 'string'
    && typeof envelope.ciphertext === 'string'
    && typeof envelope.tag === 'string';
}
