import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-namespace-'));
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
let app: FastifyInstance;
let cookie = '';
let csrfToken = '';
let providerId = '';
let modelId = '';

function mutate(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  return app.inject({ method, url: '/api/admin/' + url, headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}
function provider(slug: string) {
  return mutate('POST', 'providers', { name: slug, slug, type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'test-only', totalTimeoutMs: 1000 });
}
function combo(name: string, slug?: string) {
  return mutate('POST', 'combos', { name, slug, mode: 'fallback', members: [{ modelId, position: 0 }] });
}
function alias(name: string) {
  return mutate('POST', 'aliases', { alias: name, targetKind: 'model', targetId: modelId });
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  const credentials = { username: 'admin', password: 'namespace-test-password' };
  expect((await app.inject({ method: 'POST', url: '/api/admin/setup', payload: credentials })).statusCode).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: credentials });
  expect(login.statusCode).toBe(200);
  const header = login.headers['set-cookie'];
  cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  const csrf = await app.inject({ method: 'GET', url: '/api/admin/csrf', headers: { cookie } });
  expect(csrf.statusCode).toBe(200);
  csrfToken = csrf.json().csrfToken;
  const created = await provider('codex');
  expect(created.statusCode).toBe(200);
  providerId = created.json().id;
  const imported = await mutate('POST', 'models/import', { providerId, modelIds: ['same-model'] });
  expect(imported.statusCode).toBe(200);
  const { getRawDb } = await import('../../src/server/db');
  modelId = (getRawDb().prepare('SELECT id FROM models WHERE provider_id = ?').get(providerId) as { id: string }).id;
});

afterAll(async () => {
  await app?.close();
  (await import('../../src/server/db')).closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('provider and routing namespaces', () => {
  it('normalizes case and punctuation; rejects duplicate/reserved/empty slugs; suggests a free alternative', async () => {
    const dup = await provider(' CODEX ');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toContain('codex-oauth');
    expect((await provider('codex-oauth')).statusCode).toBe(200);
    const second = await provider('CODEX');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toContain('codex-2');
    expect((await provider('combo')).statusCode).toBe(409);
    expect((await provider('!!!')).statusCode).toBe(400);
  });

  it('rejects simultaneous duplicate creation and preserves the original provider', async () => {
    const results = await Promise.all([provider('Concurrent Name'), provider('concurrent-name')]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('locks an imported provider slug and preserves its model identity', async () => {
    const res = await mutate('PATCH', 'providers', { id: providerId, slug: 'renamed-codex' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('provider_slug_locked');
    expect((await mutate('PATCH', 'providers', { id: providerId, slug: 'CODEX', name: 'Codex relay renamed' })).statusCode).toBe(200);
    const { resolveRequestedModel } = await import('../../src/server/routing/resolver');
    expect(resolveRequestedModel('codex/same-model')).toMatchObject({ kind: 'model', modelId });
    expect(() => resolveRequestedModel('renamed-codex/same-model')).toThrow();
  });

  it('allows rename before import but not into another provider namespace', async () => {
    const created = await provider('new-empty-provider');
    const id = created.json().id;
    expect((await mutate('PATCH', 'providers', { id, slug: 'CODEX' })).statusCode).toBe(409);
    expect((await mutate('PATCH', 'providers', { id, slug: 'empty-renamed' })).statusCode).toBe(200);
    expect((await mutate('PATCH', 'providers', { id, type: 'anthropic' })).statusCode).toBe(400);
  });

  it('reserves public model prefixes left behind by a legacy slug rename', async () => {
    const { getRawDb } = await import('../../src/server/db');
    const raw = getRawDb();
    raw.prepare('UPDATE models SET public_model_id = ? WHERE id = ?').run('historical-prefix/same-model', modelId);
    try { expect((await provider('historical-prefix')).statusCode).toBe(409); }
    finally { raw.prepare('UPDATE models SET public_model_id = ? WHERE id = ?').run('codex/same-model', modelId); }
  });

  it('allows identical upstream model names under different provider UUIDs', async () => {
    const created = await provider('parallel-codex');
    const id = created.json().id;
    expect((await mutate('POST', 'models/import', { providerId: id, modelIds: ['same-model'] })).statusCode).toBe(200);
    const { resolveRequestedModel } = await import('../../src/server/routing/resolver');
    expect(resolveRequestedModel('parallel-codex/same-model')).not.toMatchObject({ modelId });
    expect(resolveRequestedModel('codex/same-model')).toMatchObject({ modelId });
  });

  it('checks alias and combo names in both directions, including bare prefixed-combo slugs', async () => {
    expect((await alias('coding-alias')).statusCode).toBe(200);
    expect((await combo('coding-alias')).statusCode).toBe(400);
    expect((await combo('Other name', 'coding-alias')).statusCode).toBe(400);
    const created = await combo('Prefixed name', 'prefixed-combo');
    expect(created.statusCode).toBe(200);
    expect((await alias('prefixed-combo')).statusCode).toBe(400);
    expect((await mutate('PATCH', 'combos', { id: created.json().id, slug: 'coding-alias' })).statusCode).toBe(400);
    const { resolveRequestedModel } = await import('../../src/server/routing/resolver');
    expect(resolveRequestedModel('prefixed-combo')).toMatchObject({ kind: 'combo', comboId: created.json().id });
  });

  it('rolls back the entire model import on a legacy namespace collision', async () => {
    const { getRawDb } = await import('../../src/server/db');
    const raw = getRawDb();
    raw.prepare("INSERT INTO providers(id,name,slug,type,base_url) VALUES ('legacy-combo-provider','legacy','combo','openai','http://127.0.0.1:1')").run();
    expect((await combo('Collision fixture', 'collision-fixture')).statusCode).toBe(200);
    const res = await mutate('POST', 'models/import', { providerId: 'legacy-combo-provider', modelIds: ['free', 'collision-fixture'] });
    expect(res.statusCode).toBe(400);
    expect(raw.prepare('SELECT id FROM models WHERE provider_id = ?').all('legacy-combo-provider')).toEqual([]);
  });
});
