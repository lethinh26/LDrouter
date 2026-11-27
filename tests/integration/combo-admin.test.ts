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

const member = (modelId: string, position = 0) => ({ modelId, position, enabled: true });

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
  return (await r.json()).combo as { slug: string; publicModelId: string; maxTotalAttempts: number; maxRequestDurationSeconds: number | null; fallbackOn429: boolean; fallbackOnTotalTimeout: boolean; slowResponseFallbackEnabled: boolean; slowResponseThresholdSeconds: number; slowResponseMaxCount: number; members: Array<{ id: string; modelId: string; providerEnabled: boolean; status: { state: string }; slowState: unknown; adaptiveStates: unknown[] }> };
};

const list = async () => {
  const r = await fetch(`${baseUrl}/api/admin/combos`, { headers: { cookie: cookies } });
  expect(r.status).toBe(200);
  return (await r.json()).combos as Array<{ id: string; status: string; healthyMemberCount: number; slowCooldownCount: number; slowProbeCount: number }>;
};

function seedAdaptive(comboId: string, modelId: string, values: Partial<typeof sch.comboAdaptiveStates.$inferInsert> = {}) {
  const combo = db.select().from(sch.combos).all().find((c) => c.id === comboId)!;
  const member = db.select().from(sch.comboMembers).all().find((m) => m.comboId === comboId && m.modelId === modelId)!;
  db.insert(sch.comboAdaptiveStates).values({ comboId, modelId, memberId: member.id, generation: combo.slowResponseGeneration,
    workload: 'complete:plain:short:short', updatedAtMs: Date.now(), ...values }).run();
}

describe('admin combo create', () => {
  it('derives the public id from the name when no slug is given', async () => {
    const r = await create({ name: 'Smart Combo', members: [member(modelA)] });
    expect(r.status).toBe(200);
    const created = await r.json();
    expect(created.publicModelId).toBe('smart-combo');
    await expect(detail(created.id)).resolves.toMatchObject({
      slowResponseFallbackEnabled: true,
      fallbackOnTotalTimeout: true,
      slowResponseThresholdSeconds: 60,
      slowResponseMaxCount: 3,
      maxRequestDurationSeconds: null,
    });
  });

  it('reports workload-specific latency, degradation and recovery without exposing lease tokens', async () => {
    const r = await create({ name: 'Slow state detail', members: [member(modelA)] });
    expect(r.status).toBe(200);
    const created = await r.json();
    const now = Date.now();
    seedAdaptive(created.id, modelA, {
      consecutiveSlowCount: 2,
      degraded: 'absolute', probeDueMs: now + 30_000,
      lastLatencyMs: 75_000,
      lastOutcome: 'soft_timeout',
      updatedAtMs: now,
      samplesJson: JSON.stringify([{ latencyMs: 2000, atMs: now }, { latencyMs: 3000, atMs: now }, { latencyMs: 4000, atMs: now }]),
      probeToken: 'private-lease-token', probeLeaseUntilMs: now + 1000,
    });
    seedAdaptive(created.id, modelA, { workload: 'stream:plain:short', updatedAtMs: now - 1, samplesJson: JSON.stringify([{ latencyMs: 500, atMs: now }]) });

    const combo = await detail(created.id);
    expect(combo.members[0]?.slowState).toMatchObject({
      consecutiveSlowCount: 2,
      lastLatencyMs: 75_000,
      lastOutcome: 'slow',
    });
    expect(combo.members[0]?.adaptiveStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ workload: 'complete:plain:short:short', latencyKind: 'completion', medianLatencyMs: 3000, sampleCount: 3, state: 'probing' }),
      expect.objectContaining({ workload: 'stream:plain:short', latencyKind: 'ttft', medianLatencyMs: 500, sampleCount: 1 }),
    ]));
    expect(JSON.stringify(combo)).not.toContain('private-lease-token');
  });

  it('reports healthy members separately from slow cooldowns and active probes in the combo list', async () => {
    const r = await create({ name: 'Slow list status', members: [member(modelA, 0), member(modelB, 1)] });
    expect(r.status).toBe(200);
    const created = await r.json();
    const now = Date.now();
    seedAdaptive(created.id, modelA, { consecutiveSlowCount: 3, degraded: 'absolute', probeDueMs: now + 30_000, lastOutcome: 'soft_timeout', updatedAtMs: now });
    seedAdaptive(created.id, modelA, { workload: 'stream:plain:short', consecutiveSlowCount: 3, degraded: 'absolute', probeDueMs: now + 30_000, updatedAtMs: now });
    seedAdaptive(created.id, modelB, { consecutiveSlowCount: 3, degraded: 'absolute', probeDueMs: now - 1, probeLeaseUntilMs: now + 30_000, probeToken: 'probe-b', lastOutcome: 'error', updatedAtMs: now });

    const listed = await list();
    expect(listed.find((combo) => combo.id === created.id)).toMatchObject({
      status: 'ready',
      healthyMemberCount: 2,
      slowCooldownCount: 1,
      slowProbeCount: 1,
    });
  });

  it('invalidates decisions and leases when the membership set changes', async () => {
    const r = await create({ name: 'Slow state member diff', members: [member(modelA, 0), member(modelB, 1)] });
    expect(r.status).toBe(200);
    const created = await r.json();
    const generationBefore = db.select().from(sch.combos).all().find((combo) => combo.id === created.id)!.slowResponseGeneration;
    const now = Date.now();
    seedAdaptive(created.id, modelA, { consecutiveSlowCount: 2, lastLatencyMs: 70_000, lastOutcome: 'soft_timeout', updatedAtMs: now });
    seedAdaptive(created.id, modelB, { consecutiveSlowCount: 1, lastLatencyMs: 65_000, lastOutcome: 'soft_timeout', updatedAtMs: now });

    const updated = await patch({ id: created.id, members: [member(modelB, 0)] });
    expect(updated.status).toBe(200);
    const combo = await detail(created.id);
    expect(combo.members).toHaveLength(1);
    expect(combo.members[0]?.modelId).toBe(modelB);
    expect(combo.members[0]?.adaptiveStates).toHaveLength(0);
    expect(db.select().from(sch.comboAdaptiveStates).all().filter((state) => state.comboId === created.id)).toHaveLength(0);
    expect(db.select().from(sch.combos).all().find((item) => item.id === created.id)?.slowResponseGeneration).toBe(generationBefore + 1);
  });

  it('clears slow history atomically when slow-response settings change', async () => {
    const r = await create({ name: 'Slow settings reset', members: [member(modelA)] });
    expect(r.status).toBe(200);
    const created = await r.json();
    const now = Date.now();
    seedAdaptive(created.id, modelA, { consecutiveSlowCount: 2, degraded: 'absolute',
      probeDueMs: now + 30_000, lastLatencyMs: 75_000, lastOutcome: 'soft_timeout', updatedAtMs: now });
    const generationBefore = db.select().from(sch.combos).all().find((combo) => combo.id === created.id)!.slowResponseGeneration;

    const updated = await patch({ id: created.id, slowResponseThresholdSeconds: 90 });
    expect(updated.status).toBe(200);
    expect(db.select().from(sch.comboAdaptiveStates).all().filter((state) => state.comboId === created.id)).toHaveLength(0);
    expect(db.select().from(sch.combos).all().find((combo) => combo.id === created.id)?.slowResponseGeneration).toBe(generationBefore + 1);
  });

  it('retains measured samples on pure reorder but fences old recovery leases', async () => {
    const created = await (await create({ name: 'Reorder adaptive', members: [member(modelA), member(modelB, 1)] })).json();
    const now = Date.now();
    const samplesJson = JSON.stringify([{ latencyMs: 1000, atMs: now }]);
    seedAdaptive(created.id, modelA, { samplesJson, degraded: 'relative', comparatorModelId: modelB, probeDueMs: now, probeLeaseUntilMs: now + 30_000, probeToken: 'old-probe' });
    const old = db.select().from(sch.comboAdaptiveStates).all().find((s) => s.comboId === created.id)!;
    expect((await patch({ id: created.id, members: [member(modelB), member(modelA, 1)] })).status).toBe(200);
    const next = db.select().from(sch.comboAdaptiveStates).all().find((s) => s.comboId === created.id)!;
    expect(next).toMatchObject({ memberId: old.memberId, generation: old.generation + 1, samplesJson, degraded: null, comparatorModelId: null, probeToken: null, probeLeaseUntilMs: null });
    expect((await detail(created.id)).members.map((m) => m.modelId)).toEqual([modelB, modelA]);
  });

  it('supports audited adaptive reset and a nullable overall deadline', async () => {
    const created = await (await create({ name: 'Reset and deadline', maxRequestDurationSeconds: 120, members: [member(modelA)] })).json();
    expect((await detail(created.id)).maxRequestDurationSeconds).toBe(120);
    seedAdaptive(created.id, modelA, { consecutiveSlowCount: 2 });
    const generationBefore = db.select().from(sch.combos).all().find((c) => c.id === created.id)!.slowResponseGeneration;
    expect((await patch({ id: created.id, maxRequestDurationSeconds: 0 })).status).toBe(400);
    expect((await patch({ id: created.id, maxRequestDurationSeconds: null })).status).toBe(200);
    expect((await detail(created.id)).maxRequestDurationSeconds).toBeNull();
    const reset = await fetch(`${baseUrl}/api/admin/combos/${created.id}/reset-adaptive-state`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: '{}' });
    expect(reset.status).toBe(200);
    expect((await detail(created.id)).members[0]?.adaptiveStates).toHaveLength(0);
    expect(db.select().from(sch.combos).all().find((c) => c.id === created.id)?.slowResponseGeneration).toBe(generationBefore + 1);
    expect(db.select().from(sch.auditLogs).all().some((a) => a.action === 'combo.adaptive.reset' && a.targetId === created.id)).toBe(true);
  });

  it('accepts an explicitly empty slug as omitted', async () => {
    const r = await create({ name: 'empty-slug', slug: '', members: [member(modelA)] });
    expect(r.status).toBe(200);
    expect((await r.json()).publicModelId).toBe('empty-slug');
  });

  it('round-trips fallback safety settings and reports member readiness', async () => {
    const r = await create({ name: 'settings', maxTotalAttempts: 5, fallbackOn429: false, fallbackOnTotalTimeout: false, slowResponseFallbackEnabled: false, slowResponseThresholdSeconds: 90, slowResponseMaxCount: 4, members: [member(modelA)] });
    expect(r.status).toBe(200);
    const combo = await detail((await r.json()).id);
    expect(combo.maxTotalAttempts).toBe(5);
    expect(combo.fallbackOn429).toBe(false);
    expect(combo.fallbackOnTotalTimeout).toBe(false);
    expect(combo.slowResponseFallbackEnabled).toBe(false);
    expect(combo.slowResponseThresholdSeconds).toBe(90);
    expect(combo.slowResponseMaxCount).toBe(4);
    expect(combo.members[0]).toMatchObject({ providerEnabled: true, status: { state: 'ready' } });
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
    const r2 = await create({ name: 'dup2', members: [member(modelA, 0), member(modelB, 1), member(modelA, 2)] });
    expect(r2.status).toBe(400);
    // Distinct models at the SAME position stay legal (positions are not unique).
    expect((await create({ name: 'same-pos', members: [member(modelA, 0), member(modelB, 0)] })).status).toBe(200);
  });

  it('leaves no orphan combo row when creation fails', async () => {
    const before = db.select().from(sch.combos).all().length;
    const membersBefore = db.select().from(sch.comboMembers).all();
    const r = await create({ name: 'never-lands', members: [member(modelA), member(modelA)] });
    expect(r.status).toBe(400);
    expect(db.select().from(sch.combos).all().length).toBe(before);
    expect(db.select().from(sch.comboMembers).all()).toEqual(membersBefore);
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
