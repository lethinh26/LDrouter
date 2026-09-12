import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-http-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance;
let baseUrl = '';
let cookie = '';
let csrf = '';
let providerId = '';
let nonCodexProviderId = '';

const jsonHeaders = () => ({ 'content-type': 'application/json', cookie });
const multipartRequest = async (fields: Record<string, string>, file: string) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', new Blob([file], { type: 'application/json' }), 'accounts.json');
  return fetch(`${baseUrl}/api/admin/codex/accounts/import`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: form });
};
const importBody = (text = '{"access_token":"access","refresh_token":"refresh","email":"user@example.com"}') => ({ providerId, text });

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { getRawDb } = await import('../../src/server/db');
  const raw = getRawDb();
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('codex-provider','Codex','codex','codex','https://codex.invalid')").run();
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('openai-provider','OpenAI','openai','openai','https://openai.invalid')").run();
  providerId = 'codex-provider';
  nonCodexProviderId = 'openai-provider';
  const sessionToken = cookie.slice('ld_session='.length);
  const { sha256Hex } = await import('../../src/server/auth/ids');
  const session = raw.prepare('SELECT id FROM admin_sessions WHERE token_digest=?').get(sha256Hex(sessionToken)) as { id: string };
  csrf = (raw.prepare('SELECT token FROM csrf_tokens WHERE session_id=?').get(session.id) as { token: string }).token;
  expect(csrf).toBeTruthy();
});

afterAll(async () => { await app.close(); (await import('../../src/server/db')).closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('authenticated Codex admin HTTP API', () => {
  it('requires a logged-in session and CSRF for mutations', async () => {
    const noSession = await fetch(`${baseUrl}/api/admin/codex/accounts/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(importBody()) });
    expect(noSession.status).toBe(401);
    const missing = await fetch(`${baseUrl}/api/admin/codex/accounts/preview`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': '' }, body: JSON.stringify(importBody()) });
    expect(missing.status).toBe(403);
    const invalid = await fetch(`${baseUrl}/api/admin/codex/accounts/preview`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': 'wrong' }, body: JSON.stringify(importBody()) });
    expect(invalid.status).toBe(403);
  });

  it('previews JSON without account or audit writes and redacts credentials', async () => {
    const { getRawDb } = await import('../../src/server/db');
    const beforeAccounts = (getRawDb().prepare('SELECT COUNT(*) AS count FROM codex_accounts').get() as { count: number }).count;
    const beforeAudits = (getRawDb().prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='codex.accounts.preview'").get() as { count: number }).count;
    const res = await fetch(`${baseUrl}/api/admin/codex/accounts/preview`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: JSON.stringify(importBody()) });
    expect(res.status).toBe(200);
    const body = await res.json() as { validCount: number; records: Array<Record<string, unknown>> };
    expect(body.validCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain('access');
    expect((getRawDb().prepare('SELECT COUNT(*) AS count FROM codex_accounts').get() as { count: number }).count).toBe(beforeAccounts);
    expect((getRawDb().prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='codex.accounts.preview'").get() as { count: number }).count).toBe(beforeAudits);
  });

  it('imports JSONL and multipart with selection, overflow, partial results, and redaction', async () => {
    const lines = Array.from({ length: 501 }, (_, i) => JSON.stringify({ access_token: `a-${i}`, refresh_token: `r-${i}`, email: `u-${i}@example.com` })).join('\n');
    const selected = [0, 500];
    const res = await fetch(`${baseUrl}/api/admin/codex/accounts/import`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: JSON.stringify({ providerId, text: lines, selectedIndexes: selected }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { added: number; failed: number; results: Array<{ index: number; status: string }> };
    expect(body.added).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results).toEqual(expect.arrayContaining([{ index: 0, status: 'added', email: 'u-0@example.com', accountIdMasked: null }, { index: 500, status: 'failed', error: 'Invalid record' }]));
    expect(JSON.stringify(body)).not.toContain('a-0');

    const form = new FormData();
    form.append('providerId', providerId);
    form.append('selectedIndexes', JSON.stringify([0]));
    form.append('file', new Blob(['{"access_token":"multipart-access","refresh_token":"multipart-refresh","email":"multi@example.com"}'], { type: 'application/json' }), 'accounts.json');
    const multipart = await fetch(`${baseUrl}/api/admin/codex/accounts/import`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: form });
    expect(multipart.status).toBe(200);
  });

  it('rejects real non-Codex providers on preview and import', async () => {
    const preview = await fetch(`${baseUrl}/api/admin/codex/accounts/preview`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: JSON.stringify({ providerId: nonCodexProviderId, text: '{}' }) });
    expect(preview.status).toBe(400);
    const imported = await fetch(`${baseUrl}/api/admin/codex/accounts/import`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: JSON.stringify({ providerId: nonCodexProviderId, text: '{}' }) });
    expect(imported.status).toBe(400);
  });

  it('rejects malformed, negative, non-integer, and over-limit multipart indexes and oversized payloads', async () => {
    for (const selectedIndexes of ['not-json', JSON.stringify([-1]), JSON.stringify([1.5]), JSON.stringify(Array.from({ length: 501 }, (_, i) => i))]) {
      const response = await multipartRequest({ providerId, selectedIndexes }, '{}');
      expect(response.status).toBe(400);
    }
    const oversized = await multipartRequest({ providerId }, 'x'.repeat(2_000_001));
    expect(oversized.status).toBe(413);
  });

  it('audits an authenticated Codex provider test without exposing credentials', async () => {
    const db = (await import('../../src/server/db')).getRawDb();
    const before = (db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='provider.test'").get() as { count: number }).count;
    const response = await fetch(`${baseUrl}/api/admin/providers/${providerId}/test`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: '{}' });
    expect([200, 502, 503]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toContain('access');
    const after = db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='provider.test'").get() as { count: number };
    expect(after.count).toBe(before + 1);
  });

  it('requires CSRF on existing authenticated provider mutations', async () => {
    const response = await fetch(`${baseUrl}/api/admin/providers/${providerId}/test`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': '' }, body: '{}' });
    expect(response.status).toBe(403);
  });

  it('validates providers and supports list/update/disable while test is explicit 501', async () => {
    const badProvider = await fetch(`${baseUrl}/api/admin/codex/accounts/preview`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: JSON.stringify({ providerId: 'missing', text: '{}' }) });
    expect(badProvider.status).toBe(404);
    const list = await fetch(`${baseUrl}/api/admin/codex/accounts?providerId=${providerId}`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const accounts = (await list.json() as { accounts: Array<{ id: string }> }).accounts;
    expect(accounts.length).toBeGreaterThan(0);
    const id = accounts[0]!.id;
    const db = (await import('../../src/server/db')).getRawDb();
    const before = db.prepare('SELECT health_state, enabled FROM codex_accounts WHERE id=?').get(id) as { health_state: string; enabled: number };
    const beforeAuditCount = (db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get() as { count: number }).count;
    const test = await fetch(`${baseUrl}/api/admin/codex/accounts/${id}/test`, { method: 'POST', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: '{}' });
    expect(test.status).toBe(501);
    const after = db.prepare('SELECT health_state, enabled FROM codex_accounts WHERE id=?').get(id) as { health_state: string; enabled: number };
    const afterAuditCount = (db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get() as { count: number }).count;
    expect(after).toEqual(before);
    expect(afterAuditCount).toBe(beforeAuditCount);
    const update = await fetch(`${baseUrl}/api/admin/codex/accounts/${id}`, { method: 'PATCH', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: JSON.stringify({ enabled: false }) });
    expect(update.status).toBe(200);
    const disabled = await fetch(`${baseUrl}/api/admin/codex/accounts/${id}`, { method: 'DELETE', headers: { ...jsonHeaders(), 'x-csrf-token': csrf }, body: '{}' });
    expect(disabled.status).toBe(200);
    const audit = (db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='codex.accounts.test' AND success=1").get() as { count: number });
    expect(audit.count).toBe(0);
  });
});
