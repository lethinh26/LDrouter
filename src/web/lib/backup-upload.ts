// Native-XHR backup upload. fetch() cannot report upload progress, so this is the one
// place we use XMLHttpRequest. The file is never read as text — it goes over the wire as
// a multipart FormData part, which also means we must NOT set Content-Type (the browser
// adds the multipart boundary).

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0-100 */
  percent: number;
}

export interface UploadBackupResult {
  ok: boolean;
  profile?: string;
  message?: string;
}

export interface UploadBackupOptions {
  file: File;
  passphrase?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** First-run Setup has no admin session, so it must not fetch /api/admin/csrf. */
  includeCsrf?: boolean;
}

function abortError(): Error {
  const error = new Error('Upload cancelled');
  error.name = 'AbortError';
  return error;
}

/** Safe message from a GatewayError JSON envelope; never surfaces raw text or paths. */
function errorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch { /* non-JSON body */ }
  return 'Restore failed';
}

function parseResult(text: string): UploadBackupResult {
  try {
    const body = JSON.parse(text) as UploadBackupResult;
    return { ok: body.ok !== false, profile: body.profile, message: body.message };
  } catch {
    return { ok: true };
  }
}

export function uploadBackup({
  file,
  passphrase,
  onProgress,
  signal,
  includeCsrf = true,
}: UploadBackupOptions): Promise<UploadBackupResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }

    const form = new FormData();
    form.append('backup', file);
    if (passphrase) form.append('passphrase', passphrase);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/backup/restore');
    xhr.withCredentials = true;

    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); fn(); };

    function onAbort() {
      settle(() => reject(abortError()));
      xhr.abort();
    }

    xhr.upload.onprogress = (event) => {
      // Some browsers report total 0; fall back to the known file size.
      const total = event.total || file.size;
      const percent = total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0;
      onProgress?.({ loaded: event.loaded, total, percent });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) settle(() => resolve(parseResult(xhr.responseText)));
      else settle(() => reject(new Error(errorMessage(xhr.responseText))));
    };
    xhr.onerror = () => settle(() => reject(new Error('Restore failed')));
    xhr.onabort = () => settle(() => reject(abortError()));

    signal?.addEventListener('abort', onAbort);

    void (async () => {
      try {
        if (includeCsrf) {
          const res = await fetch('/api/admin/csrf', { credentials: 'include' });
          if (res.ok) {
            const { csrfToken } = await res.json() as { csrfToken: string };
            xhr.setRequestHeader('x-csrf-token', csrfToken);
          }
        }
        if (!settled) xhr.send(form);
      } catch {
        settle(() => reject(new Error('Restore failed')));
      }
    })();
  });
}
