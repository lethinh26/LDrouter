// Unit: admin web API client — request shaping.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, fetchWithCsrf } from '@web/lib/api';

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
    const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('POST with a body sets content-type and JSON-encodes', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await api.post('/api/admin/providers', { name: 'x' });
    const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'x' }));
  });

  it('GET never sends a body', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await api.get('/api/admin/providers');
    const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.method).toBe('GET');
  });

  it('invalidates a cached CSRF token and retries once after an auth failure', async () => {
    let csrfCalls = 0;
    let mutationCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/admin/csrf')) {
        csrfCalls += 1;
        return new Response(JSON.stringify({ csrfToken: `token-${csrfCalls}` }), { status: 200 });
      }
      mutationCalls += 1;
      if (mutationCalls === 1) return new Response(JSON.stringify({ error: { type: 'authentication_error' } }), { status: 403 });
      expect((init?.headers as Record<string, string>)['x-csrf-token']).toBe('token-2');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/api/admin/providers', { name: 'x' });
    expect(csrfCalls).toBe(2);
    expect(mutationCalls).toBe(2);
  });

  it('POST /api/admin/setup does NOT attempt to fetch a CSRF token (no session exists on first run)', async () => {
    const calls: string[] = [];
    let sentHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      sentHeaders = { ...(init?.headers as Record<string, string> | undefined) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/api/admin/setup', { username: 'admin', password: 'x'.repeat(12) });
    expect(calls).toEqual(['/api/admin/setup']);
    expect(sentHeaders['x-csrf-token']).toBeUndefined();
  });

  it('DELETE without a body does NOT send content-type application/json', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await api.del('/api/admin/providers/some-id');
    const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  // fetchWithCsrf serves callers that need the raw Response (SSE, blobs). Those call sites used to
  // call globalThis.fetch directly and were rejected 403 because no CSRF header was attached.
  it('fetchWithCsrf attaches the CSRF token and preserves the caller headers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => _url.endsWith('/api/admin/csrf')
      ? new Response(JSON.stringify({ csrfToken: 'tok' }), { status: 200 })
      : new Response('stream', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithCsrf('/api/admin/models/m1/test-stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(await res.text()).toBe('stream');
    const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // The token is cached module-wide from an earlier case, so assert it is attached, not its value.
    expect(headers['x-csrf-token']).toBeTruthy();
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{}');
    expect(init.credentials).toBe('include');
  });

  it('fetchWithCsrf retries once with a fresh token after a 403', async () => {
    let mutations = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      if (_url.endsWith('/api/admin/csrf')) return new Response(JSON.stringify({ csrfToken: 'tok' }), { status: 200 });
      mutations += 1;
      return mutations === 1 ? new Response('nope', { status: 403 }) : new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithCsrf('/api/admin/backup/create', { method: 'POST' });
    expect(await res.text()).toBe('ok');
    expect(mutations).toBe(2);
  });
});
