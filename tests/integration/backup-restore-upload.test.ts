// Integration: streamed, disk-based multipart backup restore.
//
// The restore endpoint must accept a multipart `backup` file (v2 `.ldb`) and keep accepting the
// legacy v1 JSON body. Uploads are streamed to a private temp file, validated from disk, and only
// then swapped in. Every failure path must leave the live DB and master key untouched and remove
// every temporary file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { createLegacyDatabase, LEGACY_DAY, LEGACY_COMPACT_DAY, LEGACY_KEY, MIXED_KEY, ALL_KEY } from '../fixtures/legacy-db';

const dataDir = path.join(os.tmpdir(), `latedev-restore-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
// Keep the limit small enough to exercise 413 with a cheap fixture, but above any real snapshot here.
process.env.LATEDEV_MAX_BACKUP_UPLOAD_BYTES = String(512 * 1024);

const PASSPHRASE = '123456';
const MAX_BYTES = 512 * 1024;
const EXCLUDED_TABLES = ['requests', 'request_attempts', 'audit_logs', 'response_cache', 'admin_sessions', 'csrf_tokens', 'backups'];

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let csrfToken = '';
let providerId = '';

const restoreTmp = () => path.join(dataDir, 'restore-tmp');
const tmpFiles = (): string[] => (fs.existsSync(restoreTmp()) ? fs.readdirSync(restoreTmp()) : []);

async function waitForEmptyTmp(ms = 3000): Promise<string[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (tmpFiles().length === 0) return [];
    await new Promise((r) => setTimeout(r, 25));
  }
  return tmpFiles();
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Raw multipart framing so tests control exact byte counts (no FormData buffering surprises). */
function multipart(parts: Array<{ name: string; filename?: string; content: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = `----latedev${crypto.randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n`));
    if (part.filename) chunks.push(Buffer.from('Content-Type: application/octet-stream\r\n'));
    chunks.push(Buffer.from('\r\n'), part.content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function freshCsrf(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/admin/csrf`, { headers: { cookie: cookies } });
  csrfToken = ((await res.json()) as { csrfToken: string }).csrfToken;
  return csrfToken;
}

function postRestore(body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL('/api/admin/backup/restore', baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'content-type': contentType, 'content-length': body.length, cookie: cookies, 'x-csrf-token': csrfToken, ...extraHeaders },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON error page */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function uploadFile(file: string, passphrase = PASSPHRASE, filename = 'backup.ldb') {
  const { body, contentType } = multipart([
    { name: 'backup', filename, content: fs.readFileSync(file) },
    { name: 'passphrase', content: Buffer.from(passphrase) },
  ]);
  return postRestore(body, contentType, { 'x-csrf-token': await freshCsrf() });
}

async function exportToFile(profile: 'compact' | 'full'): Promise<string> {
  const { createBackupExport } = await import('../../src/server/backup/export');
  const { loadConfig } = await import('../../src/server/config/index');
  const { body } = await createBackupExport({ profile, passphrase: PASSPHRASE, cfg: loadConfig() });
  const file = path.join(os.tmpdir(), `latedev-upload-export-${crypto.randomUUID()}.ldb`);
  fs.writeFileSync(file, await readAll(body));
  return file;
}

/** Build an arbitrary v2 container with a chosen payload (for checksum/gzip/sqlite failure cases). */
async function buildContainer(payload: Buffer, overrides: Record<string, unknown> = {}): Promise<Buffer> {
  const { writeBackupContainer } = await import('../../src/server/backup/container');
  const manifest = {
    format: 'latedev-backup', version: 2, profile: 'compact', appVersion: '0.0.0', schemaVersion: 0,
    createdAt: new Date().toISOString(), compressedBytes: payload.length, uncompressedBytes: payload.length,
    checksum: crypto.createHash('sha256').update(payload).digest('hex'), excludedTables: EXCLUDED_TABLES,
    statistics: { granularity: 'daily', dimensions: ['model', 'provider', 'api_key'], p95Available: false },
    ...overrides,
  };
  return readAll(await writeBackupContainer({ manifest: manifest as never, payload: Readable.from(payload) }));
}

async function uploadBuffer(body: Buffer, filename = 'backup.ldb', passphrase = PASSPHRASE) {
  const { body: framed, contentType } = multipart([
    { name: 'backup', filename, content: body },
    { name: 'passphrase', content: Buffer.from(passphrase) },
  ]);
  return postRestore(framed, contentType, { 'x-csrf-token': await freshCsrf() });
}

/** Snapshot the live DB, gzip it, and passphrase-encrypt the master key exactly as v1 did. */
async function legacyEnvelope(): Promise<Record<string, unknown>> {
  const { loadConfig } = await import('../../src/server/config/index');
  const { encryptBackupMasterKey } = await import('../../src/server/auth/backup-crypto');
  const { parseMasterKey } = await import('../../src/server/auth/crypto');
  const { getSettings } = await import('../../src/server/db/repositories/settings');
  const cfg = loadConfig();
  const Database = (await import('better-sqlite3')).default;
  const temp = path.join(cfg.dataDir, `.legacy-${crypto.randomUUID()}.sqlite`);
  const source = new Database(cfg.dbFile, { readonly: true });
  try { await source.backup(temp); } finally { source.close(); }
  const compressed = zlib.gzipSync(fs.readFileSync(temp));
  fs.rmSync(temp, { force: true });
  const masterKey = parseMasterKey(cfg.masterKey ?? fs.readFileSync(path.join(cfg.dataDir, 'master.key'), 'utf8').trim());
  return {
    format: 'latedev-backup', version: 1, appVersion: '0.0.0', schemaVersion: getSettings().schemaVersion,
    masterKeyConfigured: true, createdAt: new Date().toISOString(), payload: compressed.toString('base64'),
    checksum: crypto.createHash('sha256').update(compressed).digest('hex'), keyEnvelope: encryptBackupMasterKey(masterKey, PASSPHRASE),
  };
}

async function ensureModel(upstream: string, publicModelId: string): Promise<string> {
  const db = (await import('../../src/server/db/index')).getDb();
  const schema = await import('../../src/server/db/schema');
  const { uuid } = await import('../../src/server/auth/ids');
  const existing = db.select().from(schema.models).all().find((m) => m.publicModelId === publicModelId);
  if (existing) return existing.id;
  const id = uuid();
  db.insert(schema.models).values({ id, providerId, upstreamModelId: upstream, publicModelId, displayName: publicModelId, enabled: true, upstreamAvailable: true, capabilitiesJson: '{}' }).run();
  return id;
}

async function modelIds(): Promise<string[]> {
  const db = (await import('../../src/server/db/index')).getDb();
  const schema = await import('../../src/server/db/schema');
  return db.select().from(schema.models).all().map((m) => m.publicModelId);
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (typeof addr === 'string' || !addr) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;

  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookies = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookies).toBeTruthy();
  const csrfRes = await fetch(`${baseUrl}/api/admin/csrf`, { headers: { cookie: cookies } });
  csrfToken = ((await csrfRes.json()) as { csrfToken: string }).csrfToken;

  const db = (await import('../../src/server/db/index')).getDb();
  const { uuid } = await import('../../src/server/auth/ids');
  const schema = await import('../../src/server/db/schema');
  providerId = uuid();
  db.insert(schema.providers).values({ id: providerId, name: 'p', slug: 'p', type: 'openai', baseUrl: 'http://127.0.0.1:9', enabled: true }).run();
  await ensureModel('a', 'p/a');
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('streamed multipart restore', () => {
  it('exposes the effective maximum upload size to an authenticated preflight', async () => {
    const res = await fetch(`${baseUrl}/api/admin/backup/capabilities`, { headers: { cookie: cookies } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxUploadBytes: MAX_BYTES });
  });

  it('(a) restores a valid v2 .ldb multipart upload and the live DB reflects it', async () => {
    const file = await exportToFile('compact');
    try {
      // Mutate the live DB AFTER the export: the restored snapshot must not contain model B.
      await ensureModel('b', 'p/b');
      expect(await modelIds()).toContain('p/b');

      const res = await uploadFile(file);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, profile: 'compact' });

      const ids = await modelIds();
      expect(ids).toContain('p/a');
      expect(ids).not.toContain('p/b');
      expect(await waitForEmptyTmp()).toEqual([]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('(b) rejects an upload that crosses the byte limit with 413 and leaves no temp files', async () => {
    const big = Buffer.alloc(MAX_BYTES + 64 * 1024, 7);
    const res = await uploadBuffer(big);
    expect(res.status).toBe(413);
    expect(String((res.json.error as { message?: string } | undefined)?.message ?? '')).toMatch(/maximum size/i);
    expect(await waitForEmptyTmp()).toEqual([]);
    // The oversized body never replaced the live DB.
    expect(await modelIds()).toContain('p/a');
  });

  it('(b2) enforces the limit during streaming when no Content-Length is present', async () => {
    // Chunked transfer: the server cannot pre-reject from a declared length, so only the
    // mid-stream byte counter can stop it before the stored bytes exceed the maximum.
    const { body, contentType } = multipart([{ name: 'backup', filename: 'backup.ldb', content: Buffer.alloc(MAX_BYTES + 64 * 1024, 5) }]);
    const url = new URL('/api/admin/backup/restore', baseUrl);
    const csrf = await freshCsrf();
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': contentType, 'transfer-encoding': 'chunked', cookie: cookies, 'x-csrf-token': csrf } },
        (res) => { const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c as Buffer)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })); },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(result.status).toBe(413);
    expect(await waitForEmptyTmp()).toEqual([]);
    expect(await modelIds()).toContain('p/a');
  });

  it('(c) an aborted upload leaves no temp files', async () => {
    await ensureModel('a', 'p/a');
    const { body, contentType } = multipart([{ name: 'backup', filename: 'backup.ldb', content: Buffer.alloc(300 * 1024, 3) }]);
    const url = new URL('/api/admin/backup/restore', baseUrl);
    const csrf = await freshCsrf();
    await new Promise<void>((resolve) => {
      const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': contentType, 'content-length': body.length, cookie: cookies, 'x-csrf-token': csrf } });
      req.on('error', () => resolve());
      req.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => { req.destroy(); resolve(); }, 60);
    });
    expect(await waitForEmptyTmp()).toEqual([]);
  });

  it('(d) rejects checksum mismatch, non-gzip, non-SQLite, and wrong passphrase without touching live state', async () => {
    const masterKeyBefore = process.env.LATEDEV_MASTER_KEY;

    // A real, gzip-compressed SQLite payload (from the live DB) to build near-valid containers.
    const Database = (await import('better-sqlite3')).default;
    const { loadConfig } = await import('../../src/server/config/index');
    const cfg = loadConfig();
    const snapshot = path.join(os.tmpdir(), `latedev-snap-${crypto.randomUUID()}.sqlite`);
    const live = new Database(cfg.dbFile, { readonly: true });
    try { await live.backup(snapshot); } finally { live.close(); }
    const realSqlite = fs.readFileSync(snapshot);
    fs.rmSync(snapshot, { force: true });

    const goodGzip = zlib.gzipSync(realSqlite);
    const cases: Array<{ label: string; body: Buffer }> = [
      { label: 'checksum', body: await buildContainer(goodGzip, { checksum: 'a'.repeat(64) }) },
      { label: 'non-gzip', body: await buildContainer(Buffer.from('definitely not gzip')) },
      { label: 'non-sqlite', body: await buildContainer(zlib.gzipSync(Buffer.from('not a sqlite database at all'))) },
      { label: 'future-schema', body: await buildContainer(goodGzip, { schemaVersion: 999 }) },
    ];
    for (const c of cases) {
      const res = await uploadBuffer(c.body);
      expect(res.status, `${c.label} must be a 4xx`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await modelIds()).toContain('p/a');
      expect(process.env.LATEDEV_MASTER_KEY).toBe(masterKeyBefore);
      expect(await waitForEmptyTmp()).toEqual([]);
    }

    // Wrong passphrase on an otherwise valid backup.
    const file = await exportToFile('compact');
    try {
      const res = await uploadFile(file, '654321');
      expect(res.status).toBe(400);
      expect(await modelIds()).toContain('p/a');
      expect(process.env.LATEDEV_MASTER_KEY).toBe(masterKeyBefore);
      expect(await waitForEmptyTmp()).toEqual([]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('(e) still accepts the legacy v1 JSON restore body', async () => {
    const envelope = await legacyEnvelope();
    await ensureModel('b', 'p/b');
    const res = await fetch(`${baseUrl}/api/admin/backup/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, 'x-csrf-token': await freshCsrf() },
      body: JSON.stringify({ backup: envelope, passphrase: PASSPHRASE }),
    });
    expect(res.status).toBe(200);
    const ids = await modelIds();
    expect(ids).toContain('p/a');
    expect(ids).not.toContain('p/b');
  });

  it('(f) a compact restore serves aggregate-only history with unavailable percentiles', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const schema = await import('../../src/server/db/schema');
    const modelId = await ensureModel('a', 'p/a');
    (await import('../../src/server/db/index')).getRawDb().prepare('DELETE FROM daily_model_stats').run();
    db.insert(schema.dailyModelStats).values({ day: '2026-01-01', modelId, requests: 4, successfulRequests: 4, failedRequests: 0, inputTokens: 40, outputTokens: 20, latencySuccessSumMs: 800, latencySuccessCount: 4 }).run();

    const file = await exportToFile('compact');
    try {
      // The live raw/aggregate rows for that day are gone; only the compact backup keeps them.
      (await import('../../src/server/db/index')).getRawDb().prepare('DELETE FROM daily_model_stats WHERE day = ?').run('2026-01-01');

      const res = await uploadFile(file);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, profile: 'compact' });

      const stats = await fetch(`${baseUrl}/api/admin/stats?from=${encodeURIComponent('2026-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-01-01T23:59:59.999Z')}`, { headers: { cookie: cookies } });
      expect(stats.status).toBe(200);
      const body = await stats.json() as { percentilesAvailable: boolean; summary: { totalRequests: number; p95LatencyMs: number | null; p95TtftMs: number | null; averageLatencyMs: number } };
      expect(body.percentilesAvailable).toBe(false);
      expect(body.summary.totalRequests).toBe(4);
      expect(body.summary.averageLatencyMs).toBe(200);
      expect(body.summary.p95LatencyMs).toBeNull();
      expect(body.summary.p95TtftMs).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('invalidates restored probe owners and old attempt fences while preserving fresh latency samples', async () => {
    const {getRawDb} = await import('../../src/server/db/index');
    const {loadCombo} = await import('../../src/server/routing/combo');
    const {beginAdaptiveAttempt,listAdaptiveStates,recordAdaptiveOutcome,claimAdaptiveProbe} = await import('../../src/server/routing/combo-adaptive-state');
    const db = getRawDb();
    const modelId = await ensureModel('a','p/a');
    const now = Date.now();
    const workload = 'stream:plain:short';
    db.prepare("INSERT INTO combos(id,name,slug,public_model_id,mode) VALUES ('restore-adaptive','Adaptive restore','restore-adaptive','combo/restore-adaptive','fallback')").run();
    db.prepare("INSERT INTO combo_members(id,combo_id,model_id,position) VALUES ('restore-member','restore-adaptive',?,0)").run(modelId);
    const generation = loadCombo('restore-adaptive')!.slowResponseGeneration!;
    const samples = [{latencyMs:70_000,atMs:now-1000}];
    db.prepare(`INSERT INTO combo_adaptive_states(
      combo_id,member_id,model_id,workload,generation,samples_json,consecutive_slow_count,degraded,
      probe_due_ms,probe_lease_until_ms,probe_token,recovery_successes,last_observation_ms,last_start_ms,last_start_sequence,updated_at_ms
    ) VALUES ('restore-adaptive','restore-member',?,?,?,?,3,'absolute',?,?,'old-backup-owner',1,?,?,42,?)`)
      .run(modelId,workload,generation,JSON.stringify(samples),now-100,now+120_000,now-1000,now-2000,now-1000);
    db.prepare(`INSERT INTO combo_adaptive_states(combo_id,member_id,model_id,workload,generation,updated_at_ms)
      VALUES ('restore-adaptive','restore-member',?,'complete:plain:short:short',?,?)`)
      .run(modelId,generation,now-16*60_000);
    const oldFence=beginAdaptiveAttempt();
    const file=await exportToFile('full');
    try {
      db.prepare("UPDATE combo_adaptive_states SET probe_token='newer-live-owner' WHERE combo_id='restore-adaptive' AND workload=?").run(workload);
      const result=await uploadFile(file);
      expect(result.status,JSON.stringify(result.json)).toBe(200);
      const restoredPlan=loadCombo('restore-adaptive')!;
      expect(restoredPlan.slowResponseGeneration).toBe(generation+1);
      const restored=listAdaptiveStates('restore-adaptive');
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({samples,degraded:'absolute',probeToken:null,probeLeaseUntilMs:null,recoverySuccesses:0,lastStartSequence:0});
      const candidate={modelId,comboMemberId:'restore-member',publicModelId:'p/a',upstreamModelId:'a',providerId,enabled:true,upstreamAvailable:true,circuitOpen:false,providerEnabled:true,capabilities:{streaming:true}};
      recordAdaptiveOutcome({plan:restoredPlan,candidate,workload,startedAtMs:now,now:Date.now(),kind:'success',
        latencyMs:8000,role:'normal',comparableCandidates:[candidate],learn:true,attemptFence:oldFence});
      expect(listAdaptiveStates('restore-adaptive',workload)[0]?.samples).toEqual(samples);
      const token=claimAdaptiveProbe(restoredPlan,candidate,workload,Date.now(),120_000);
      expect(token).toBeTruthy();
      expect(token).not.toBe('old-backup-owner');
      expect(token).not.toBe('newer-live-owner');
      expect(await waitForEmptyTmp()).toEqual([]);
    } finally {fs.rmSync(file,{force:true});}
  });

  it.each(['v1','v2'] as const)('rejects a falsely stamped schema-14 %s backup before swapping the live database', async (format) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-forged-restore-'));
    try {
      const old = createLegacyDatabase(dir);
      try {
        old.exec("INSERT INTO schema_migrations(version,name) VALUES (14,'remove_legacy_providers'); UPDATE app_settings SET schema_version=14");
        expect(old.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
        expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { old.close(); }
      const bytes = fs.readFileSync(path.join(dir,'legacy.sqlite'));
      const payload = zlib.gzipSync(bytes);
      const { getRawDb } = await import('../../src/server/db/index');
      const before = getRawDb();
      const masterKey = process.env.LATEDEV_MASTER_KEY;
      const models = await modelIds();
      let result;
      if (format === 'v1') {
        const response = await fetch(`${baseUrl}/api/admin/backup/restore`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, 'x-csrf-token': await freshCsrf() },
          body: JSON.stringify({ backup: {
            format: 'latedev-backup', version: 1, schemaVersion: 14,
            payload: payload.toString('base64'), checksum: crypto.createHash('sha256').update(payload).digest('hex'),
          }, passphrase: PASSPHRASE }),
        });
        result = { status: response.status, json: await response.json() };
      } else {
        result = await uploadBuffer(await buildContainer(payload, {
          profile:'full', excludedTables:[], schemaVersion:14, uncompressedBytes:bytes.length,
        }));
      }
      expect(result.status,JSON.stringify(result.json)).toBe(400);
      expect(getRawDb()).toBe(before);
      expect(await modelIds()).toEqual(models);
      expect(process.env.LATEDEV_MASTER_KEY).toBe(masterKey);
      expect(await waitForEmptyTmp()).toEqual([]);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });

  it.each(['v1', 'v2-full', 'v2-compact'] as const)('upgrades a genuine pre-0014 %s backup before replacing the live DB', async (format) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-legacy-restore-'));
    try {
      const old = createLegacyDatabase(dir);
      try {
        if (format === 'v2-compact') {
          for (const table of EXCLUDED_TABLES) old.exec('DELETE FROM ' + table);
        }
      } finally { old.close(); }
      const payload = zlib.gzipSync(fs.readFileSync(path.join(dir, 'legacy.sqlite')));
      const { encryptBackupMasterKey } = await import('../../src/server/auth/backup-crypto');
      const { parseMasterKey } = await import('../../src/server/auth/crypto');
      const { loadConfig } = await import('../../src/server/config/index');
      const keyEnvelope = encryptBackupMasterKey(parseMasterKey(loadConfig().masterKey!), PASSPHRASE);
      const { getRawDb } = await import('../../src/server/db/index');
      const before = getRawDb();
      let result;
      if (format === 'v1') {
        const response = await fetch(`${baseUrl}/api/admin/backup/restore`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, 'x-csrf-token': await freshCsrf() },
          body: JSON.stringify({ backup: {
            format: 'latedev-backup', version: 1, schemaVersion: 0,
            payload: payload.toString('base64'), checksum: crypto.createHash('sha256').update(payload).digest('hex'), keyEnvelope,
          }, passphrase: PASSPHRASE }),
        });
        result = { status: response.status, json: await response.json() };
      } else {
        const profile = format === 'v2-full' ? 'full' : 'compact';
        const container = await buildContainer(payload, {
          schemaVersion: 0, profile, keyEnvelope,
          excludedTables: profile === 'compact' ? EXCLUDED_TABLES : [],
          uncompressedBytes: fs.statSync(path.join(dir, 'legacy.sqlite')).size,
        });
        result = await uploadBuffer(container);
      }
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      const db = getRawDb();
      expect(db).not.toBe(before);
      expect(db.prepare('SELECT schema_version FROM app_settings').get()).toEqual({schema_version:15});
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='combo_member_slow_states'").get()).toBeUndefined();
      expect(db.prepare('SELECT * FROM combo_adaptive_states').all()).toEqual([]);
      expect(db.prepare('SELECT type FROM providers ORDER BY type').all()).toEqual([{type:'anthropic'},{type:'openai'}]);
      expect(db.prepare("SELECT id FROM models ORDER BY id").all()).toEqual([{id:'m-anthropic'},{id:'m-openai'}]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('codex_accounts','qoder_accounts')").all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare("SELECT enabled FROM combos WHERE id='empty'").get()).toEqual({enabled:0});
      expect(db.prepare("SELECT id FROM combo_members WHERE combo_id='mixed' ORDER BY position").all()).toEqual([{id:'member-openai'},{id:'member-anthropic'}]);
      expect(db.prepare('SELECT COUNT(*) n FROM requests').get()).toEqual({n:format === 'v2-compact' ? 0 : 3});
      expect(db.prepare('SELECT COUNT(*) n FROM request_attempts').get()).toEqual({n:format === 'v2-compact' ? 0 : 4});
      expect(db.prepare('SELECT SUM(requests) n FROM daily_model_stats').get()).toEqual({n:8});
      expect(db.prepare('SELECT SUM(attempts) n FROM daily_provider_stats').get()).toEqual({n:9});
      expect(db.prepare('SELECT SUM(requests) n FROM daily_api_key_stats').get()).toEqual({n:8});
      const { authenticateGatewayKey, keyAllowedFor } = await import('../../src/server/auth/api-key');
      const key = (secret: string) => authenticateGatewayKey({ headers: { authorization: 'Bearer ' + secret } })!;
      expect(keyAllowedFor(key(LEGACY_KEY),'model','m-openai')).toBe(false);
      expect(keyAllowedFor(key(LEGACY_KEY),'model','m-anthropic')).toBe(false);
      expect(keyAllowedFor(key(MIXED_KEY),'model','m-openai')).toBe(true);
      expect(keyAllowedFor(key(MIXED_KEY),'model','m-anthropic')).toBe(false);
      expect(keyAllowedFor(key(ALL_KEY),'model','m-anthropic')).toBe(true);
      const stats = await fetch(`${baseUrl}/api/admin/stats?from=${LEGACY_COMPACT_DAY}T00:00:00.000Z&to=${LEGACY_DAY}T23:59:59.999Z`, {headers:{cookie:cookies}});
      expect(stats.status).toBe(200);
      const body = await stats.json() as {summary:{totalRequests:number;inputTokens:number;outputTokens:number};topModels:Array<{publicId:string;requests:number}>};
      expect(body.summary).toMatchObject({totalRequests:8,inputTokens:112,outputTokens:28});
      expect(body.topModels).toContainEqual(expect.objectContaining({publicId:'Deleted model (m-retired-a)',requests:6}));
      expect(await waitForEmptyTmp()).toEqual([]);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
});
