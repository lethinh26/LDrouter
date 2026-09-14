// Integration: auto-imported capability metadata must not block requests whose
// capability is merely UNKNOWN. Regression guard for the discovery heuristic
// that used to stamp `image_input: false` on every model name it could not
// pattern-match, hard-rejecting vision requests (502, zero upstream calls).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.tmpdir(), `latedev-import-cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.LATEDEV_DATA_DIR = dataDir;
process.env.LATEDEV_MASTER_KEY = 'a'.repeat(32);
process.env.LATEDEV_PORT = '0';
process.env.LATEDEV_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

// Names the old heuristic scored as image_input:false (no "vision"/"gpt-4o"/
// "claude" substring) even though the upstream genuinely accepts images.
const UPSTREAM_IDS = ['gemini-2.5-pro', 'qwen-vl-max', 'grok-4'];

let mockUpstream: import('http').Server | undefined;
let mockPort = 0;
const upstreamBodies: string[] = [];
let app: import('fastify').FastifyInstance | undefined;
let baseUrl = '';
let cookies = '';
let apiKey = '';

beforeAll(async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      upstreamBodies.push(body);
      res.setHeader('content-type', 'application/json');
      if (String(req.url).endsWith('/v1/models')) {
        res.end(JSON.stringify({ object: 'list', data: UPSTREAM_IDS.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      res.end(JSON.stringify({
        id: 'c', object: 'chat.completion', created: 0, model: 'x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('mock port');
  mockPort = addr.port;
  mockUpstream = srv;

  const { buildApp } = await import('../../src/server/app');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const a2 = app.server.address();
  if (typeof a2 === 'string' || !a2) throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${a2.port}`;
  await fetch(`${baseUrl}/api/admin/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'super-secret-password-1234' }) });
  cookies = login.headers.get('set-cookie') ?? '';
  const prov = await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'agg', slug: 'agg', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: 'sk-x', enabled: true, totalTimeoutMs: 5000, firstTokenTimeoutMs: 5000 }),
  });
  if (!prov.ok) throw new Error(`provider ${prov.status} ${await prov.text()}`);
  const key = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'test', allowAllModels: true }),
  });
  apiKey = ((await key.json()) as { secret: string }).secret;
});

afterAll(async () => {
  if (app) await app.close();
  if (mockUpstream) await new Promise<void>((r) => mockUpstream!.close(() => r()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('imported capabilities do not block unknown-capability requests', () => {
  it('leaves guessed capabilities unknown, and an image request still routes', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const provider = db.select().from(sch.providers).all().find((p) => p.slug === 'agg')!;

    const imp = await fetch(`${baseUrl}/api/admin/models/import`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ providerId: provider.id, modelIds: UPSTREAM_IDS }),
    });
    expect(imp.status).toBe(200);
    expect((await imp.json()).imported).toBe(UPSTREAM_IDS.length);

    // Discovery must not claim these models are KNOWN to reject images.
    for (const m of db.select().from(sch.models).all()) {
      const caps = JSON.parse(m.capabilitiesJson) as Record<string, unknown>;
      expect(caps.image_input, `image_input for ${m.publicModelId}`).not.toBe(false);
    }

    upstreamBodies.length = 0;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'agg/qwen-vl-max',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        ] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(upstreamBodies.length).toBe(1);
    expect(upstreamBodies[0]).toContain('image_url');
  });

  it('PATCH can pin and release a capability override (null clears to unknown)', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const model = db.select().from(sch.models).all().find((m) => m.publicModelId === 'agg/qwen-vl-max')!;
    const patch = async (capabilities: Record<string, boolean | null>) => {
      const r = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies },
        body: JSON.stringify({ id: model.id, capabilities }),
      });
      expect(r.status).toBe(200);
      return JSON.parse(db.select().from(sch.models).all().find((m) => m.id === model.id)!.capabilitiesJson) as Record<string, unknown>;
    };

    // Pin image_input=false: the admin declares images unsupported.
    expect((await patch({ image_input: false })).image_input).toBe(false);

    // And that declaration must actually block the request.
    upstreamBodies.length = 0;
    const blocked = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'agg/qwen-vl-max', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }] }),
    });
    // 400 capability_not_supported, naming the model and the missing capability —
    // NOT a 502 "no candidates", which told the caller nothing.
    expect(blocked.status).toBe(400);
    const be = ((await blocked.json()) as { error: { message: string; type: string } }).error;
    expect(be.type).toBe('capability_not_supported');
    expect(be.message).toContain('qwen-vl-max');
    expect(be.message).toContain('image input');
    expect(upstreamBodies.length).toBe(0);

    // Release it back to unknown: the key must be removed, not left as null.
    expect('image_input' in (await patch({ image_input: null }))).toBe(false);
    const allowed = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'agg/qwen-vl-max', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }] }),
    });
    expect(allowed.status).toBe(200);
  });

  it('re-import heals a pre-upgrade record that has no discovery baseline', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const { eq } = await import('drizzle-orm');
    const provider = db.select().from(sch.providers).all().find((p) => p.slug === 'agg')!;
    const read = () => JSON.parse(db.select().from(sch.models).all().find((m) => m.publicModelId === 'agg/qwen-vl-max')!.capabilitiesJson) as Record<string, unknown>;
    const modelId = db.select().from(sch.models).all().find((m) => m.publicModelId === 'agg/qwen-vl-max')!.id;

    // Exactly the state a database from the previous version is in: a guessed
    // `image_input: false` and no discovery baseline to compare against.
    db.update(sch.models)
      .set({ capabilitiesJson: JSON.stringify({ chat: true, streaming: true, tools: true, image_input: false }), discoveredMetadataJson: null })
      .where(eq(sch.models.id, modelId))
      .run();

    const imp = await fetch(`${baseUrl}/api/admin/models/import`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ providerId: provider.id, modelIds: ['qwen-vl-max'] }),
    });
    expect(imp.status).toBe(200);

    const after = read();
    expect(after.image_input).not.toBe(false);

    upstreamBodies.length = 0;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'agg/qwen-vl-max', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }] }),
    });
    expect(res.status).toBe(200);
    expect(upstreamBodies.length).toBe(1);
  });

  it('re-import preserves an admin override', async () => {
    const db = (await import('../../src/server/db/index')).getDb();
    const sch = await import('../../src/server/db/schema');
    const provider = db.select().from(sch.providers).all().find((p) => p.slug === 'agg')!;
    const row = () => db.select().from(sch.models).all().find((m) => m.publicModelId === 'agg/qwen-vl-max')!;
    const read = () => JSON.parse(row().capabilitiesJson) as Record<string, unknown>;

    // The previous test left a fresh baseline in place, so this override is
    // unambiguously an admin edit rather than staleness.
    expect(row().discoveredMetadataJson).not.toBeNull();
    const r = await fetch(`${baseUrl}/api/admin/models`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ id: row().id, capabilities: { audio_input: true, tools: false } }),
    });
    expect(r.status).toBe(200);

    const imp = await fetch(`${baseUrl}/api/admin/models/import`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ providerId: provider.id, modelIds: ['qwen-vl-max'] }),
    });
    expect(imp.status).toBe(200);

    const after = read();
    expect(after.audio_input).toBe(true); // override discovery never reports
    expect(after.tools).toBe(false); // override contradicting discovery
  });
});
