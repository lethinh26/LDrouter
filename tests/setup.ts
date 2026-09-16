// Vitest setup — applied to all unit + integration tests.
import { afterEach, beforeAll } from 'vitest';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// setupFiles re-run for every test file, but globalThis is shared across files in the same fork
// (singleFork: true). Re-reading globalThis.fetch would wrap the previous file's wrapper, so
// capture the pristine implementation the first time and reuse it.
const nativeFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? globalThis.fetch;


async function fetchWithAdminCsrf(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (!mutationMethods.has(method)) return nativeFetch(input, init);

  const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const cookie = requestHeaders.get('cookie');
  if (!cookie || requestHeaders.has('x-csrf-token')) return nativeFetch(input, init);

  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!target.includes('/api/admin/') || target.includes('/api/admin/codex/')) return nativeFetch(input, init);

  const csrfUrl = new URL('/api/admin/csrf', target);
  const csrfResponse = await nativeFetch(csrfUrl, { headers: { cookie } });
  if (!csrfResponse.ok) return nativeFetch(input, init);
  const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
  requestHeaders.set('x-csrf-token', csrfToken);
  return nativeFetch(input, { ...init, headers: requestHeaders });
}

globalThis.fetch = fetchWithAdminCsrf;

// Escape hatch: this wrapper silently supplies a CSRF token for every admin mutation, so a test
// that needs to observe the real 401/403 surface must bypass it. Use
// `(globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch`.
(globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch = nativeFetch;

beforeAll(() => {
  // Force a deterministic TZ for date math
  process.env.TZ = process.env.TZ ?? 'UTC';
});

afterEach(() => {
  // Each test is responsible for its own cleanup
});
