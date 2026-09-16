import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deserializeCatalog,
  exchangeQoderPat,
  fetchQoderCatalog,
  isQoderPat,
  parseCatalog,
  serializeCatalog,
} from '../../src/server/providers/qoder/catalog';

afterEach(() => vi.unstubAllGlobals());

const body = {
  chat: [
    {
      key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, is_reasoning: true, is_vl: false,
      max_input_tokens: 200_000, max_output_tokens: 32_768,
      context_config: [{ name: '200K', tokenCount: 200_000, isDefault: true }], source: 'system',
    },
    { key: 'hidden_model', display_name: 'Hidden', enable: false, is_reasoning: false, is_vl: true, max_input_tokens: 100_000, max_output_tokens: 8_192 },
  ],
};

describe('Qoder catalog', () => {
  it('accepts only personal access tokens', () => {
    expect(isQoderPat('pt-abc')).toBe(true);
    expect(isQoderPat('dt-abc')).toBe(false);
    expect(isQoderPat('jt-abc')).toBe(false);
    expect(isQoderPat('')).toBe(false);
    expect(isQoderPat(null)).toBe(false);
    expect(isQoderPat(undefined)).toBe(false);
  });

  it('exchanges a PAT for a job token and user id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jt-1', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'user-9', email: 'dev@example.com', name: 'Dev' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await exchangeQoderPat('pt-secret');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://openapi.qoder.sh/api/v1/jobToken/exchange');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ personal_token: 'pt-secret' });
    // The exchange is plain JSON, never COSY-signed.
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('Cosy-Key');
    expect(result).toMatchObject({ jobToken: 'jt-1', qoderUserId: 'user-9', email: 'dev@example.com', label: 'Dev' });
  });

  it('rejects a non-PAT token before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeQoderPat('jt-already')).rejects.toThrow('not a Qoder personal access token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts the token when the exchange fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"errorCode":"Unauthorized"}', { status: 401 })));
    await expect(exchangeQoderPat('pt-secret')).rejects.toThrow('HTTP 401');
    await expect(exchangeQoderPat('pt-secret')).rejects.not.toThrow('pt-secret');
  });

  it('fails when the exchange returns no job token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(exchangeQoderPat('pt-secret')).rejects.toThrow('returned no job token');
  });

  it('parses the live catalog and keeps hidden entries routable', () => {
    const catalog = parseCatalog(body, '2026-09-16T00:00:00.000Z');
    expect([...catalog.entries.keys()]).toEqual(['qmodel_38max', 'hidden_model']);
    expect(catalog.entries.get('qmodel_38max')).toMatchObject({
      displayName: 'Qwen3.8-Max', isReasoning: true, isVl: false, maxInputTokens: 200_000, maxOutputTokens: 32_768, enabled: true,
    });
    expect(catalog.entries.get('hidden_model')).toMatchObject({ enabled: false, isVl: true });
  });

  it('tolerates a malformed catalog body instead of throwing', () => {
    expect(parseCatalog(null, 'x').entries.size).toBe(0);
    expect(parseCatalog({ chat: 'nope' }, 'x').entries.size).toBe(0);
    expect(parseCatalog({ chat: [null, 'x', { noKey: 1 }] }, 'x').entries.size).toBe(0);
  });

  it('fetches the model list with COSY headers on the inference host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = await fetchQoderCatalog({ jobToken: 'jt-1', userId: 'user-9', machineId: 'machine-1' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api2.qoder.sh/algo/api/v2/model/list');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer COSY\./);
    expect(headers['Cosy-User']).toBe('user-9');
    expect(headers['Cosy-Bodylength']).toBe('0');
    expect(catalog?.entries.size).toBe(2);
  });

  it('returns null when the model list cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })));
    await expect(fetchQoderCatalog({ jobToken: 'jt-1', userId: 'user-9', machineId: 'm' })).resolves.toBeNull();
  });

  it('returns null when the model list request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(fetchQoderCatalog({ jobToken: 'jt-1', userId: 'user-9', machineId: 'm' })).resolves.toBeNull();
  });

  it('round-trips a serialized catalog and tolerates a corrupt blob', () => {
    const catalog = parseCatalog(body, '2026-09-16T00:00:00.000Z');
    expect(deserializeCatalog(serializeCatalog(catalog))?.entries.get('qmodel_38max')?.maxOutputTokens).toBe(32_768);
    expect(deserializeCatalog(serializeCatalog(catalog))?.entries.get('qmodel_38max')?.raw).toMatchObject({ source: 'system' });
    expect(deserializeCatalog('{not json')).toBeNull();
    expect(deserializeCatalog(null)).toBeNull();
  });
});
