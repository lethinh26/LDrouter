// Tiny typed fetch wrapper for admin + gateway APIs.

const baseUrl = '';

export class ApiError extends Error {
  constructor(public status: number, public type: string, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: { message?: string } }).error?.message ?? body) : 'Request failed');
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
    ...init,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!res.ok) throw new ApiError(res.status, typeof parsed === 'object' && parsed && 'error' in parsed ? String((parsed as { error: { type?: string } }).error?.type ?? 'error') : 'error', parsed);
  return parsed as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('POST', path, body, init),
  patch: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('PATCH', path, body, init),
  put: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('PUT', path, body, init),
  del: <T>(path: string) => request<T>('DELETE', path),
};
