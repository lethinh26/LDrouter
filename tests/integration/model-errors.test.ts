// Integration: routing failures must name the model and the real reason.
//
// Before: a physical model that cannot do what the request needs answered
// "No available model candidates" (502), while a combo answered
// "No combo member satisfies the request capabilities or availability" (400) —
// two opaque strings for the same underlying problem, neither saying WHICH model
// failed or WHY. docs/13 §10 flags that message as a known bug.
//
// After: one taxonomy, the offending model named by its bare model name (the
// provider prefix is dropped: `vl/gpt-5.5` is reported as `gpt-5.5`), and an
// explicit reason per filtered model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';

const dataDir = path.join(os.tmpdir(), `latedev-model-errors-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let apiKey = '';
let db: ReturnType<(typeof import('../../src/server/db/index'))['getDb']>;
let sch: typeof import('../../src/server/db/schema');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const IMAGE_CONTENT = [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }];
const TEXT_CONTENT = 'hello';

let seq = 0;
const mkModel = (upstreamId: string, caps: Record<string, unknown>, opts: { enabled?: boolean; upstreamAvailable?: boolean } = {}) => {
  const id = `m${++seq}`;
  db.insert(sch.models).values({
    id, providerId: 'p1', upstreamModelId: upstreamId, publicModelId: `vl/${upstreamId}`,
    displayName: upstreamId, enabled: opts.enabled ?? true, upstreamAvailable: opts.upstreamAvailable ?? true,
    capabilitiesJson: JSON.stringify(caps),
  }).run();
  return id;
};

const mkCombo = (slug: string, modelIds: string[]) => {
  const id = `c${++seq}`;
  db.insert(sch.combos).values({ id, name: slug, slug, publicModelId: slug, mode: 'fallback', enabled: true, maxTotalAttempts: 3, configVersion: 1 }).run();
  modelIds.forEach((modelId, i) => {
    db.insert(sch.comboMembers).values({ id: `cm${++seq}`, comboId: id, modelId, position: i, weight: 1, enabled: true }).run();
  });
  return id;
};

const chat = (model: string, content: unknown) =>
  fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });

const err = async (r: Response) => (await r.json()).error as { message: string; type: string; code?: string };

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
  const key = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'errors', allowAllModels: true }),
  });
  apiKey = ((await key.json()) as { secret: string }).secret;

  db = (await import('../../src/server/db/index')).getDb();
  sch = await import('../../src/server/db/schema');
  const now = new Date().toISOString();
  db.insert(sch.providers).values({ id: 'p1', name: 'vl', slug: 'vl', type: 'openai', baseUrl: 'http://127.0.0.1:1', encryptedApiKey: 'x', apiKeyNonce: 'y', apiKeyVersion: 1, enabled: true, createdAt: now, updatedAt: now }).run();
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const NO_IMAGE = { chat: true, streaming: true, tools: true, image_input: false };
const ALL_TRUE = { chat: true, streaming: true, tools: true, image_input: true };

describe('direct physical model rejections', () => {
  it('names the model and the missing capability instead of "No available model candidates"', async () => {
    mkModel('gpt-5.5', NO_IMAGE);
    const r = await chat('vl/gpt-5.5', IMAGE_CONTENT);
    const e = await err(r);
    // The model is named by its BARE name — no "vl/" provider prefix.
    expect(e.message).toContain('gpt-5.5');
    expect(e.message).not.toContain('vl/gpt-5.5');
    expect(e.message).toContain('image input');
    expect(e.type).toBe('capability_not_supported');
    expect(r.status).toBe(400);
    expect(e.code).toBe('capability_not_supported');
    // The old opaque string must be gone.
    expect(e.message).not.toContain('No available model candidates');
  });

  it('distinguishes a disabled model from a capability miss', async () => {
    mkModel('disabled-one', ALL_TRUE, { enabled: false });
    const r = await chat('vl/disabled-one', TEXT_CONTENT);
    const e = await err(r);
    expect(e.message).toContain('disabled-one');
    expect(e.message).toMatch(/disabled/i);
    expect(e.message).not.toContain('capabilities');
    expect(e.type).toBe('upstream_unavailable');
  });

  it('distinguishes a model missing upstream from a capability miss', async () => {
    mkModel('gone-upstream', ALL_TRUE, { upstreamAvailable: false });
    const r = await chat('vl/gone-upstream', TEXT_CONTENT);
    const e = await err(r);
    expect(e.message).toContain('gone-upstream');
    expect(e.message).not.toContain('capabilities');
    expect(e.type).toBe('upstream_unavailable');
  });

  it('keeps a clear 404 for a genuinely unknown model', async () => {
    const r = await chat('vl/nope-not-here', TEXT_CONTENT);
    expect(r.status).toBe(404);
    expect((await err(r)).type).toBe('model_not_found');
  });
});

describe('combo rejections', () => {
  it('reports every member that lacks the capability, not a blanket message', async () => {
    const a = mkModel('qwen-vl-max', NO_IMAGE);
    const b = mkModel('grok-4', NO_IMAGE);
    mkCombo('vision-combo', [a, b]);
    const r = await chat('vision-combo', IMAGE_CONTENT);
    const e = await err(r);
    expect(r.status).toBe(400);
    expect(e.type).toBe('capability_not_supported');
    expect(e.message).toContain('qwen-vl-max');
    expect(e.message).toContain('grok-4');
    expect(e.message).toContain('image input');
    expect(e.message).not.toContain('No combo member satisfies');
    // Bare model names only — combo members are physical models with prefixes.
    expect(e.message).not.toContain('vl/');
  });

  it('reports availability reasons as availability, not capability', async () => {
    const a = mkModel('down-a', ALL_TRUE, { upstreamAvailable: false });
    const b = mkModel('down-b', ALL_TRUE, { upstreamAvailable: false });
    mkCombo('down-combo', [a, b]);
    const r = await chat('down-combo', TEXT_CONTENT);
    const e = await err(r);
    expect(e.type).toBe('upstream_unavailable');
    expect(e.message).toContain('down-a');
    expect(e.message).toContain('down-b');
    expect(e.message).not.toContain('capabilities');
    expect(r.status).toBe(502);
  });

  it('reports a mix of capability and availability reasons together', async () => {
    const a = mkModel('mixed-caps', NO_IMAGE);
    const b = mkModel('mixed-down', ALL_TRUE, { upstreamAvailable: false });
    mkCombo('mixed-combo', [a, b]);
    const r = await chat('mixed-combo', IMAGE_CONTENT);
    const e = await err(r);
    expect(e.message).toContain('mixed-caps');
    expect(e.message).toContain('mixed-down');
    expect(e.message).toContain('image input');
    expect(e.type).toBe('capability_not_supported');
  });

  it('still routes when a member can serve the request', async () => {
    // No upstream server here, so the winner will fail to connect — what matters
    // is that filtering no longer rejects the whole combo up front.
    const a = mkModel('good-caps', ALL_TRUE);
    mkCombo('ok-combo', [a]);
    const r = await chat('ok-combo', IMAGE_CONTENT);
    expect(r.status).not.toBe(400);
  });

  it('reports a disabled combo as disabled, not as unavailable members', async () => {
    const a = mkModel('in-disabled-combo', ALL_TRUE);
    const comboId = mkCombo('off-combo', [a]);
    db.update(sch.combos).set({ enabled: false }).where(eq(sch.combos.id, comboId)).run();
    const r = await chat('off-combo', TEXT_CONTENT);
    const e = await err(r);
    expect(e.message).toContain('off-combo');
    expect(e.message).toMatch(/disabled/i);
    expect(e.type).toBe('upstream_unavailable');
    expect(r.status).toBe(502);
  });

  it('names the model when the upstream 200 has the wrong shape', async () => {
    // A 200 with no "choices" array used to surface the raw JS TypeError
    // "Cannot read properties of undefined (reading '0')" to the API client.
    const a = mkModel('wrong-shape', ALL_TRUE);
    const r = await chat(`vl/wrong-shape`, TEXT_CONTENT);
    const e = await err(r);
    expect(e.message).not.toContain('undefined');
    expect(e.message).not.toMatch(/Cannot read properties/);
    void a;
  });
});
