// Qoder upstream behaviour against a stubbed transport. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QoderUpstreamError, callQoderNonStreaming, probeQoderInference } from '../../src/server/providers/qoder/client';
import { parseCatalog } from '../../src/server/providers/qoder/catalog';
import type { CanonicalRequest } from '../../src/server/routing/capabilities';

afterEach(() => vi.unstubAllGlobals());

const catalog = parseCatalog({ chat: [
  { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, max_input_tokens: 200_000, max_output_tokens: 32_768, source: 'system' },
] }, '2026-09-16T00:00:00.000Z');

const cfg = { accountRecordId: 'acct-1', qoderUserId: 'user-9', jobToken: 'jt-1', machineId: 'machine-1', totalTimeoutMs: 5_000, catalog };
const request: CanonicalRequest = { model: 'qoder/qmodel_38max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], stream: false };

const sse = (payloads: unknown[], options: { requestId?: string | null } = {}) => {
  const body = payloads.map((payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`).join('');
  const headers: Record<string, string> = options.requestId === null ? {} : { 'x-request-id': options.requestId ?? 'up-1' };
  return new Response(body, { status: 200, headers });
};

const ok = (inner: unknown) => ({ statusCodeValue: 200, body: JSON.stringify(inner) });
const content = (text: string) => ok({ id: 'c1', choices: [{ index: 0, delta: { content: text } }] });

describe('Qoder upstream (mocked)', () => {
  it('assembles text from an envelope stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([content('hello '), content('world')])));
    const result = await callQoderNonStreaming(cfg, request);
    expect(result.text).toBe('hello world');
    expect(result.status).toBe(200);
  });

  it('marks a code 112 envelope as a billing error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([{ statusCodeValue: 403, body: '{"code":"112","message":"quota exhausted"}' }])));
    const error = await callQoderNonStreaming(cfg, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QoderUpstreamError);
    expect((error as QoderUpstreamError).status).toBe(403);
    expect((error as QoderUpstreamError).billing).toBe(true);
  });

  it('reports a null upstream request id when the header is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([content('x')], { requestId: null })));
    const result = await callQoderNonStreaming(cfg, request);
    expect(result.upstreamRequestId).toBeNull();
  });

  it('returns at EOF with a null finish reason when no terminal frame arrives', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([content('partial')])));
    const result = await callQoderNonStreaming(cfg, request);
    expect(result.text).toBe('partial');
    expect(result.finishReason).toBeNull();
  });
});

// The account "Test" button used to ask only for the catalog, so an account that was refused on
// every chat (Qoder answers the refusal as an envelope 403 inside an HTTP 200 body) still reported
// "Connected". The probe now sends one real message.
describe('probeQoderInference', () => {
  const freeCatalog = parseCatalog({ chat: [
    { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, is_free: true, max_input_tokens: 200_000, max_output_tokens: 32_768 },
    { key: 'dmodel', display_name: 'DeepSeek', enable: true, is_free: false, max_input_tokens: 200_000, max_output_tokens: 32_768 },
  ] }, '2026-09-16T00:00:00.000Z');

  it('proves inference and prefers a promotion-covered model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([content('pong')]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeQoderInference({ ...cfg, catalog: freeCatalog });
    expect(result.ok).toBe(true);
    // The request body is obfuscated on the wire, so the chosen model is read off the detail.
    expect(result.detail).toContain('qmodel_38max');
    expect(result.detail).toContain('free');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the first catalog entry when nothing is promoted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([content('pong')])));
    const paidOnly = parseCatalog({ chat: [
      { key: 'dmodel', display_name: 'DeepSeek', enable: true, is_free: false, max_input_tokens: 200_000, max_output_tokens: 32_768 },
    ] }, '2026-09-16T00:00:00.000Z');
    const result = await probeQoderInference({ ...cfg, catalog: paidOnly });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('Inference OK (dmodel)');
  });

  it('reports an out-of-Credits account as failing, naming the free models that still work', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([{ statusCodeValue: 403, body: '{"code":"112","message":"quota exhausted","pricingUrl":"https://qoder.com/pricing"}' }])));
    const result = await probeQoderInference({ ...cfg, catalog: freeCatalog });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('out of Credits');
    expect(result.detail).toContain('qmodel_38max');
  });

  it('says plainly that nothing works when no model is promotion-covered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([{ statusCodeValue: 403, body: '{"code":"112"}' }])));
    const paidOnly = parseCatalog({ chat: [{ key: 'dmodel', display_name: 'DeepSeek', enable: true, is_free: false }] }, '2026-09-16T00:00:00.000Z');
    const result = await probeQoderInference({ ...cfg, catalog: paidOnly });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('nothing it serves will work');
    expect(result.detail).not.toContain('still work');
  });

  it('fails when there is no catalog to test against', async () => {
    const result = await probeQoderInference({ ...cfg, catalog: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('catalog is empty');
  });
});
