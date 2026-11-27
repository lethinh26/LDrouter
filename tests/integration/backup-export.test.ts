// Compact/full export: streams a consistent SQLite snapshot into the v2 container without ever
// buffering the payload, pruning forensic tables for the compact profile.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBackupContainerHeader, streamBackupPayload } from '../../src/server/backup/container';

const dataDir = path.join(os.tmpdir(), `latedev-backup-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

const PASSPHRASE = '123456';
const EXCLUDED_TABLES = ['requests', 'request_attempts', 'audit_logs', 'response_cache', 'admin_sessions', 'csrf_tokens', 'backups'];
const RETAINED_TABLES = ['app_settings', 'admin_account', 'providers', 'models', 'api_keys', 'daily_model_stats', 'daily_provider_stats', 'daily_api_key_stats'];

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportToFile(profile: 'compact' | 'full'): Promise<{ manifest: import('../../src/server/backup/container').BackupManifestV2; file: string }> {
  const { createBackupExport } = await import('../../src/server/backup/export');
  const { loadConfig } = await import('../../src/server/config/index');
  const { manifest, body } = await createBackupExport({ profile, passphrase: PASSPHRASE, cfg: loadConfig() });
  const file = path.join(os.tmpdir(), `latedev-export-${crypto.randomUUID()}.ldb`);
  await pipeline(body, fs.createWriteStream(file));
  return { manifest, file };
}

/** Parse the container header, then decompress the payload exactly as a restore would. */
async function openExportedPayload(file: string) {
  const { manifest, payloadOffset } = await readBackupContainerHeader(file);
  const compressed = await readAll(streamBackupPayload(file, payloadOffset));
  const sqliteBytes = zlib.gunzipSync(compressed);
  const sqlitePath = path.join(os.tmpdir(), `latedev-exported-${crypto.randomUUID()}.sqlite`);
  fs.writeFileSync(sqlitePath, sqliteBytes);
  return { manifest, compressed, sqliteBytes, sqlite: new Database(sqlitePath, { readonly: true }) };
}

const countOf = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookies = login.headers.get('set-cookie') ?? '';

  const { getRawDb } = await import('../../src/server/db/index');
  const { uuid } = await import('../../src/server/auth/ids');
  const raw = getRawDb();

  const providerId = uuid();
  const modelId = uuid();
  const apiKeyId = uuid();
  raw.prepare('INSERT INTO providers (id,name,slug,type,base_url) VALUES (?,?,?,?,?)').run(providerId, 'mock', 'mockbackup', 'openai', 'http://127.0.0.1:9');
  raw.prepare('INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name) VALUES (?,?,?,?,?)').run(modelId, providerId, 'm', 'mockbackup/m', 'M');
  raw.prepare('INSERT INTO api_keys (id,name,key_prefix,key_digest) VALUES (?,?,?,?)').run(apiKeyId, 'k', 'ld-test', uuid());
  raw.prepare('INSERT INTO daily_model_stats (day,model_id,requests,successful_requests) VALUES (?,?,?,?)').run('2026-01-01', modelId, 5, 5);
  raw.prepare('INSERT INTO daily_provider_stats (day,provider_id,attempts,successful_attempts) VALUES (?,?,?,?)').run('2026-01-01', providerId, 5, 5);
  raw.prepare('INSERT INTO daily_api_key_stats (day,api_key_id,requests) VALUES (?,?,?)').run('2026-01-01', apiKeyId, 5);

  // Repetitive JSON skeleton with a unique random tail: exactly the shape of real log rows.
  const payload = () => `{"messages":[{"role":"user","content":"${'a'.repeat(500)}${crypto.randomBytes(1024).toString('hex')}"}]}`;
  const insertRequest = raw.prepare('INSERT INTO requests (id,created_at,api_key_id,client_ip,protocol,endpoint,requested_model,resolved_target_kind,final_model_id,streaming,http_status,success,total_latency_ms,input_tokens,output_tokens,total_tokens,attempts_count,request_payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertAttempt = raw.prepare('INSERT INTO request_attempts (id,request_id,attempt_number,provider_id,model_id,started_at,success,latency_ms,selection_reason) VALUES (?,?,?,?,?,?,?,?,?)');
  const insertAudit = raw.prepare('INSERT INTO audit_logs (id,created_at,action,success,metadata_json) VALUES (?,?,?,?,?)');
  const insertCache = raw.prepare('INSERT INTO response_cache (id,cache_key,target_kind,target_id,protocol,response_json,expires_at) VALUES (?,?,?,?,?,?,?)');
  raw.transaction(() => {
    for (let i = 0; i < 200; i++) {
      const id = uuid();
      insertRequest.run(id, '2026-01-02T12:00:00.000Z', apiKeyId, '127.0.0.1', 'openai', '/v1/chat/completions', 'mockbackup/m', 'model', modelId, 0, 200, 1, 100, 1, 1, 2, 1, payload());
      insertAttempt.run(uuid(), id, 1, providerId, modelId, '2026-01-02T12:00:00Z', 1, 100, 'primary');
      insertAudit.run(uuid(), '2026-01-02T12:00:00.000Z', 'request.completed', 1, payload());
      insertCache.run(uuid(), `key-${i}`, 'model', modelId, 'openai', payload(), '2030-01-01T00:00:00.000Z');
    }
  })();
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('compact/full backup export', () => {
  it('drops every excluded table while retaining configuration and daily aggregates', async () => {
    const { file } = await exportToFile('compact');
    const { sqlite } = await openExportedPayload(file);
    try {
      for (const table of EXCLUDED_TABLES) expect(countOf(sqlite, table), `${table} must be empty`).toBe(0);
      for (const table of RETAINED_TABLES) expect(countOf(sqlite, table), `${table} must be retained`).toBeGreaterThan(0);
    } finally {
      sqlite.close();
      fs.rmSync(file, { force: true });
    }
  });

  it('keeps request, attempt, audit, and cache rows in the full profile', async () => {
    const { file } = await exportToFile('full');
    const { sqlite } = await openExportedPayload(file);
    try {
      expect(countOf(sqlite, 'requests')).toBe(200);
      expect(countOf(sqlite, 'request_attempts')).toBe(200);
      expect(countOf(sqlite, 'audit_logs')).toBeGreaterThan(0);
      expect(countOf(sqlite, 'response_cache')).toBe(200);
    } finally {
      sqlite.close();
      fs.rmSync(file, { force: true });
    }
  });

  it('makes the compact export materially smaller than the full export', async () => {
    const compact = await exportToFile('compact');
    const full = await exportToFile('full');
    try {
      expect(compact.manifest.compressedBytes * 2).toBeLessThan(full.manifest.compressedBytes);
      expect(compact.manifest.uncompressedBytes).toBeLessThan(full.manifest.uncompressedBytes);
    } finally {
      fs.rmSync(compact.file, { force: true });
      fs.rmSync(full.file, { force: true });
    }
  });

  it('emits a v2 container whose manifest and checksum match the compressed payload', async () => {
    const { file } = await exportToFile('compact');
    const { manifest, compressed, sqliteBytes, sqlite } = await openExportedPayload(file);
    try {
      expect(manifest.format).toBe('latedev-backup');
      expect(manifest.version).toBe(2);
      expect(manifest.profile).toBe('compact');
      expect(manifest.excludedTables).toEqual(EXCLUDED_TABLES);
      expect(manifest.statistics).toEqual({ granularity: 'daily', dimensions: ['model', 'provider', 'api_key'], p95Available: false });
      expect(manifest.compressedBytes).toBe(compressed.length);
      expect(manifest.uncompressedBytes).toBe(sqliteBytes.length);
      expect(crypto.createHash('sha256').update(compressed).digest('hex')).toBe(manifest.checksum);
      expect(manifest.keyEnvelope?.algorithm).toBe('scrypt-aes-256-gcm');
      expect(sqliteBytes.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000');
      expect(countOf(sqlite, 'requests')).toBe(0);
    } finally {
      sqlite.close();
      fs.rmSync(file, { force: true });
    }
  });

  it('leaves no snapshot or gzip temp files behind in the data dir', async () => {
    const { file } = await exportToFile('compact');
    fs.rmSync(file, { force: true });
    let leftovers = fs.readdirSync(dataDir).filter((name) => name.startsWith('.export-') || name.includes('snapshot'));
    for (let i = 0; i < 40 && leftovers.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      leftovers = fs.readdirSync(dataDir).filter((name) => name.startsWith('.export-') || name.includes('snapshot'));
    }
    expect(leftovers).toEqual([]);
  });

  it('serves the create route as a streamed .ldb attachment', async () => {
    const response = await fetch(`${baseUrl}/api/admin/backup/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ passphrase: PASSPHRASE, profile: 'compact' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="latedev-backup-.*\.ldb"$/);
    const file = path.join(os.tmpdir(), `latedev-route-${crypto.randomUUID()}.ldb`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    try {
      const { manifest, payloadOffset } = await readBackupContainerHeader(file);
      expect(manifest.profile).toBe('compact');
      expect(manifest.excludedTables).toEqual(EXCLUDED_TABLES);
      expect(payloadOffset).toBeGreaterThan(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('rejects a passphrase that is not six digits', async () => {
    const response = await fetch(`${baseUrl}/api/admin/backup/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ passphrase: 'abc', profile: 'compact' }),
    });
    expect(response.status).toBe(400);
  });
});
