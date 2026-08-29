// Unit: admin web API client — request shaping.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '@web/lib/api';

const jsonResponse = { ok: true };

function mockFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    void init;
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('api client request shaping', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POST without a body does NOT send content-type application/json (Fastify rejects empty JSON bodies)', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await api.post('/api/admin/providers/some-id/test');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('POST with a body sets content-type and JSON-encodes', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await api.post('/api/admin/providers', { name: 'x' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'x' }));
  });

  it('GET never sends a body', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await api.get('/api/admin/providers');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.method).toBe('GET');
  });

  it('DELETE without a body does NOT send content-type application/json', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await api.del('/api/admin/providers/some-id');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});
