// Tiny typed fetch wrapper for admin + gateway APIs.

const baseUrl = '';
const csrfHeader = 'x-csrf-token';
// Public POST endpoints: no admin session exists yet (login) or is not required
// (first-run setup), so fetching /api/admin/csrf — which needs auth — would fail
// with "Unable to acquire CSRF token".
const CSRF_EXEMPT_PATHS = new Set(['/api/admin/login', '/api/admin/setup']);
let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  csrfRequest ??= fetch(`${baseUrl}/api/admin/csrf`, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) throw new Error('Unable to acquire CSRF token');
      const body = await res.json() as { csrfToken: string };
      csrfToken = body.csrfToken;
      return csrfToken;
    })
    .finally(() => { csrfRequest = null; });
  return csrfRequest;
}

export class ApiError extends Error {
  constructor(public status: number, public type: string, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: { message?: string } }).error?.message ?? body) : 'Request failed');
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!res.ok) throw new ApiError(res.status, typeof parsed === 'object' && parsed && 'error' in parsed ? String((parsed as { error: { type?: string } }).error?.type ?? 'error') : 'error', parsed);
  return parsed as T;
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit, retry = true): Promise<T> {
  const hasBody = body !== undefined;
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && !CSRF_EXEMPT_PATHS.has(path) && !headers[csrfHeader]) headers[csrfHeader] = await getCsrfToken();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  try {
    return await parseResponse<T>(res);
  } catch (error) {
    const authFailure = error instanceof ApiError && (error.status === 401 || error.status === 403) &&
      (error.type === 'authentication_error' || error.type === 'csrf_error');
    if (retry && authFailure && method !== 'GET' && method !== 'HEAD' && !CSRF_EXEMPT_PATHS.has(path)) {
      csrfToken = null;
      return request<T>(method, path, body, init, false);
    }
    throw error;
  }
}

async function upload<T>(path: string, form: FormData, retry = true): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { [csrfHeader]: await getCsrfToken() },
    body: form,
    credentials: 'include',
  });
  try {
    return await parseResponse<T>(res);
  } catch (error) {
    const authFailure = error instanceof ApiError && (error.status === 401 || error.status === 403) &&
      (error.type === 'authentication_error' || error.type === 'csrf_error');
    if (retry && authFailure) {
      csrfToken = null;
      return upload<T>(path, form, false);
    }
    throw error;
  }
}

/**
 * fetch with the admin CSRF header, for callers that need the raw Response (SSE streams, blobs)
 * instead of the parsed JSON that `api.*` returns. Credentials are included. Retries once with a
 * fresh token on 403: a long-lived session can rotate the token out from under a cached value.
 */
export async function fetchWithCsrf(path: string, init?: RequestInit, retry = true): Promise<Response> {
  const headers = { ...(init?.headers as Record<string, string> | undefined), [csrfHeader]: await getCsrfToken() };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, credentials: 'include' });
  if (retry && res.status === 403) {
    csrfToken = null;
    return fetchWithCsrf(path, init, false);
  }
  return res;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('POST', path, body, init),
  upload,
  patch: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('PATCH', path, body, init),
  put: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('PUT', path, body, init),
  del: <T>(path: string, init?: RequestInit) => request<T>('DELETE', path, undefined, init),
};
