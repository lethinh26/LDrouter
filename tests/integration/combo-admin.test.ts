// Integration: admin combo create/edit is atomic and reports collisions as 400s.
//
// Three reachable 500s used to hide behind `{"message":"Gateway error"}`:
//  1. a name colliding with an existing combo's *slug* (slug and public_model_id
//     are separate UNIQUE columns) surfaced as a raw SQLITE_CONSTRAINT;
//  2. two member rows for one model hit UNIQUE(combo_id, model_id);
//  3. worst of the three, a create that failed part-way still COMMITTED the combo
//     row, leaving a memberless combo and burning the name forever.
// Plus: PATCH re-derived the id whenever `slug` was present, so "open edit, save
// nothing" silently renamed `smart` to `combo/smart` and broke every alias.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-combo-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let modelA = '';
let modelB = '';
type DB = ReturnType<(typeof import('../../src/server/db/index'))['getDb']>;
let db: DB;
let sch: typeof import('../../src/server/db/schema');

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

  db = (await import('../../src/server/db/index')).getDb();
  sch = await import('../../src/server/db/schema');
  const { uuid } = await import('../../src/server/auth/ids');
  const now = new Date().toISOString();
  db.insert(sch.providers).values({ id: 'p1', name: 'p1', slug: 'p1', type: 'openai', baseUrl: 'http://127.0.0.1:1', encryptedApiKey: 'x', apiKeyNonce: 'y', apiKeyVersion: 1, enabled: true, createdAt: now, updatedAt: now }).run();
  modelA = uuid();
  modelB = uuid();
  db.insert(sch.models).values({ id: modelA, providerId: 'p1', upstreamModelId: 'a', publicModelId: 'p1/a', displayName: 'A', enabled: true, upstreamAvailable: true, capabilitiesJson: '{}' }).run();
  db.insert(sch.models).values({ id: modelB, providerId: 'p1', upstreamModelId: 'b', publicModelId: 'p1/b', displayName: 'B', enabled: true, upstreamAvailable: true, capabilitiesJson: '{}' }).run();
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const member = (modelId: string, position = 0) => ({ modelId, position, weight: 1, enabled: true });

const create = (body: Record<string, unknown>) =>
  fetch(`${baseUrl}/api/admin/combos`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ mode: 'fallback', ...body }),
  });

const patch = (body: Record<string, unknown>) =>
  fetch(`${baseUrl}/api/admin/combos`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify(body),
  });

const detail = async (id: string) => {
  const r = await fetch(`${baseUrl}/api/admin/combos/${id}`, { headers: { cookie: cookies } });
  expect(r.status).toBe(200);
  return (await r.json()).combo as { slug: string; publicModelId: string; members: Array<{ modelId: string }> };
};

describe('admin combo create', () => {
  it('derives the public id from the name when no slug is given', async () => {
    const r = await create({ name: 'Smart Combo', members: [member(modelA)] });
    expect(r.status).toBe(200);
    expect((await r.json()).publicModelId).toBe('smart-combo');
  });

  it('rejects a duplicate name with 400, not a 500', async () => {
    expect((await create({ name: 'twin', members: [member(modelA)] })).status).toBe(200);
    const dup = await create({ name: 'twin', members: [member(modelA)] });
    expect(dup.status).toBe(400);
    expect(((await dup.json()).error.message as string)).toMatch(/already in use/i);
  });

  it('rejects a name that collides with another combo slug with 400, not a 500', async () => {
    // "combo/beta" owns slug="beta"; the new slugless combo "beta" would reuse it
    // while its own public_model_id ("beta") is free — the old check missed this.
    const slugged = await create({ name: 'beta', slug: 'beta', members: [member(modelA)] });
    expect(slugged.status).toBe(200);
    expect((await slugged.json()).publicModelId).toBe('combo/beta');
    const slugless = await create({ name: 'beta', members: [member(modelA)] });
    expect(slugless.status).toBe(400);
  });

  it('rejects duplicate members with 400, not a 500', async () => {
    const r = await create({ name: 'dup', members: [member(modelA, 0), member(modelA, 1)] });
    expect(r.status).toBe(400);
    expect(((await r.json()).error.message as string)).toMatch(/duplicate members/i);
    // A repeated model across a weighted list is the same mistake.
    const r2 = await create({ name: 'dup2', mode: 'weighted_round_robin', members: [member(modelA, 0), member(modelB, 1), member(modelA, 2)] });
    expect(r2.status).toBe(400);
    // Distinct models at the SAME position stay legal (positions are not unique).
    expect((await create({ name: 'same-pos', members: [member(modelA, 0), member(modelB, 0)] })).status).toBe(200);
  });

  it('leaves no orphan combo row when creation fails', async () => {
    const before = db.select().from(sch.combos).all().length;
    const r = await create({ name: 'never-lands', members: [member(modelA), member(modelA)] });
    expect(r.status).toBe(400);
    expect(db.select().from(sch.combos).all().length).toBe(before);
    expect(db.select().from(sch.comboMembers).all().some((m) => m.modelId === modelA && m.position === 1)).toBe(false);
    // The name is still free, so the operator can retry it.
    expect((await create({ name: 'never-lands', members: [member(modelA)] })).status).toBe(200);
  });

  it('rejects a body with no members', async () => {
    expect((await create({ name: 'empty', members: [] })).status).toBe(400);
  });
});

describe('admin combo edit', () => {
  it('keeps the public model id across an edit that does not touch the slug', async () => {
    const created = await (await create({ name: 'keeper', members: [member(modelA)] })).json();
    const d = await detail(created.id);
    expect(d.publicModelId).toBe('keeper');

    // Exactly what the UI sends after openEdit(): name round-trips, slug omitted
    // for a combo whose id carries no "combo/" prefix.
    const res = await patch({ id: created.id, name: 'keeper', mode: 'fallback', enabled: true, members: [member(modelA), member(modelB, 1)] });
    expect(res.status).toBe(200);
    const after = await detail(created.id);
    expect(after.publicModelId).toBe('keeper');
    expect(after.members.map((m) => m.modelId).sort()).toEqual([modelA, modelB].sort());
  });

  it('applies an explicitly supplied slug', async () => {
    const created = await (await create({ name: 'renamable', members: [member(modelA)] })).json();
    expect((await patch({ id: created.id, slug: 'renamed', members: [member(modelA)] })).status).toBe(200);
    const after = await detail(created.id);
    expect(after.publicModelId).toBe('combo/renamed');
    expect(after.slug).toBe('renamed');
  });

  it('rejects a rename onto an existing id without touching members', async () => {
    const created = await (await create({ name: 'safe', members: [member(modelA), member(modelB, 1)] })).json();
    const res = await patch({ id: created.id, slug: 'keeper', members: [member(modelA)] });
    expect(res.status).toBe(400);
    // The rejected rename must not have dropped the second member.
    expect((await detail(created.id)).members).toHaveLength(2);
  });

  it('rejects duplicate members on edit and keeps the stored list', async () => {
    const created = await (await create({ name: 'stable', members: [member(modelA), member(modelB, 1)] })).json();
    const res = await patch({ id: created.id, members: [member(modelA, 0), member(modelA, 1)] });
    expect(res.status).toBe(400);
    expect((await detail(created.id)).members).toHaveLength(2);
  });

  it('persists drag-and-drop priority as member order', async () => {
    // Exactly what the drag UI sends: the same members, re-indexed by row order.
    const created = await (await create({ name: 'draggable', members: [member(modelA, 0), member(modelB, 1)] })).json();
    expect((await detail(created.id)).members.map((m) => m.modelId)).toEqual([modelA, modelB]);
    const moved = await patch({ id: created.id, members: [member(modelB, 0), member(modelA, 1)] });
    expect(moved.status).toBe(200);
    expect((await detail(created.id)).members.map((m) => m.modelId)).toEqual([modelB, modelA]);
  });
});
