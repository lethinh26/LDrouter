import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_MAGIC,
  MAX_BACKUP_MANIFEST_BYTES,
  readBackupContainerHeader,
  streamBackupPayload,
  writeBackupContainer,
  type BackupManifestV2,
} from '../../src/server/backup/container';

function compactManifest(payload: Buffer): BackupManifestV2 {
  return {
    format: 'latedev-backup', version: 2, profile: 'compact', appVersion: '1.0.0', schemaVersion: 1,
    createdAt: '2026-10-11T00:00:00.000Z', compressedBytes: payload.length, uncompressedBytes: 42,
    checksum: crypto.createHash('sha256').update(payload).digest('hex'), excludedTables: ['requests'],
    statistics: { granularity: 'daily', dimensions: ['model', 'provider', 'api_key'], p95Available: false },
  };
}

async function materialize(payload: Buffer, manifest = compactManifest(payload)): Promise<string> {
  const file = path.join(os.tmpdir(), `latedev-backup-${crypto.randomUUID()}.ldb`);
  await fs.writeFile(file, await readAll(await writeBackupContainer({ manifest, payload: Readable.from(payload) })));
  return file;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('v2 backup container', () => {
  it('reads a file header and streams the exact payload from its returned offset', async () => {
    const payload = Buffer.from('sqlite bytes');
    const file = await materialize(payload);
    try {
      const { manifest, payloadOffset } = await readBackupContainerHeader(file);
      expect(manifest.profile).toBe('compact');
      expect(payloadOffset).toBeGreaterThan(0);
      await expect(readAll(streamBackupPayload(file, payloadOffset))).resolves.toEqual(payload);
    } finally { await fs.rm(file, { force: true }); }
  });

  it('requests only the 9-byte prefix and declared manifest, never payload', async () => {
    const payload = Buffer.from('payload-not-to-read');
    const file = await materialize(payload);
    const calls: Array<{ length: number; position: number }> = [];
    const realHandle = await fs.open(file, 'r');
    const open = async () => ({
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        calls.push({ length, position });
        return realHandle.read(buffer, offset, length, position);
      },
      close: () => realHandle.close(),
    });
    try {
      const { manifest } = await readBackupContainerHeader(file, async () => open());
      const manifestLength = Buffer.byteLength(JSON.stringify(manifest));
      expect(calls).toEqual([{ length: 9, position: 0 }, { length: manifestLength, position: 9 }]);
    } finally { await realHandle.close(); await fs.rm(file, { force: true }); }
  });

  it('rejects invalid manifest fields', async () => {
    const payload = Buffer.from('sqlite bytes');
    const manifest = { ...compactManifest(payload), checksum: 'invalid' } as BackupManifestV2;
    const file = await materialize(payload, manifest);
    try { await expect(readBackupContainerHeader(file)).rejects.toThrow('Invalid backup manifest'); }
    finally { await fs.rm(file, { force: true }); }
  });

  it.each([
    [Buffer.from('BAD!\x02\x00\x00\x00\x00', 'binary'), 'Invalid backup magic'],
    [Buffer.from('LDRB\x02\x00\x00\x00\x02{', 'binary'), 'Truncated backup header'],
    [Buffer.from('LDRB\x03\x00\x00\x00\x00', 'binary'), 'Unsupported backup version'],
    [Buffer.from('LDRB\x02\x00', 'binary'), 'Truncated backup header'],
  ])('rejects malformed or truncated header bytes', async (bytes, message) => {
    const file = path.join(os.tmpdir(), `latedev-backup-${crypto.randomUUID()}.ldb`);
    await fs.writeFile(file, bytes);
    try { await expect(readBackupContainerHeader(file)).rejects.toThrow(message); }
    finally { await fs.rm(file, { force: true }); }
  });

  it('rejects an oversized manifest length before reading its body', async () => {
    const bytes = Buffer.alloc(9);
    BACKUP_MAGIC.copy(bytes);
    bytes.writeUInt8(2, 4);
    bytes.writeUInt32BE(MAX_BACKUP_MANIFEST_BYTES + 1, 5);
    const file = path.join(os.tmpdir(), `latedev-backup-${crypto.randomUUID()}.ldb`);
    await fs.writeFile(file, bytes);
    try { await expect(readBackupContainerHeader(file)).rejects.toThrow('Backup manifest exceeds maximum size'); }
    finally { await fs.rm(file, { force: true }); }
  });
});
