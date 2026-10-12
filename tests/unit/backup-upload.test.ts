// Unit: backup upload helper — real XHR progress, abort, error mapping, CSRF opt-out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadBackup } from '@web/lib/backup-upload';

// Controllable XMLHttpRequest stand-in. The helper only touches: open, setRequestHeader,
// upload.onprogress, onload/onerror/onabort, withCredentials, send, abort, status, responseText.
class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() { FakeXHR.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; }
  send(body: unknown) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }

  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total } as ProgressEvent);
  }
  respond(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

function makeFile(name = 'b.ldb', content = 'abc') {
  return new File([content], name, { type: 'application/octet-stream' });
}

describe('uploadBackup', () => {
  beforeEach(() => { FakeXHR.instances = []; vi.stubGlobal('XMLHttpRequest', FakeXHR); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('maps upload progress events to { loaded, total, percent }', async () => {
    const onProgress = vi.fn();
    const p = uploadBackup({ file: makeFile(), onProgress, includeCsrf: false });
    const xhr = FakeXHR.instances[0]!;
    xhr.emitProgress(50, 100);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 100, percent: 50 });
    xhr.respond(200, JSON.stringify({ ok: true }));
    await p;
  });

  it('falls back to file.size when the browser reports total = 0', async () => {
    const onProgress = vi.fn();
    const p = uploadBackup({ file: makeFile('b.ldb', 'abcdefghij'), onProgress, includeCsrf: false });
    const xhr = FakeXHR.instances[0]!;
    xhr.emitProgress(5, 0);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 5, total: 10, percent: 50 });
    xhr.respond(200, JSON.stringify({ ok: true }));
    await p;
  });

  it('rejects with name === AbortError and calls xhr.abort() when the signal aborts', async () => {
    const controller = new AbortController();
    const p = uploadBackup({ file: makeFile(), signal: controller.signal, includeCsrf: false });
    const xhr = FakeXHR.instances[0]!;
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.aborted).toBe(true);
  });

  it('rejects with the JSON error envelope message on a non-2xx response', async () => {
    const p = uploadBackup({ file: makeFile(), includeCsrf: false });
    const xhr = FakeXHR.instances[0]!;
    xhr.respond(400, JSON.stringify({ error: { message: 'Backup checksum mismatch' } }));
    await expect(p).rejects.toThrow('Backup checksum mismatch');
  });

  it('never surfaces raw response text or paths for a non-JSON error body', async () => {
    const p = uploadBackup({ file: makeFile(), includeCsrf: false });
    const xhr = FakeXHR.instances[0]!;
    xhr.respond(500, 'C:\\Users\\admin\\data\\restore-tmp\\abc.sqlite boom');
    await expect(p).rejects.toThrow('Restore failed');
    await expect(p).rejects.not.toThrow(/restore-tmp/);
  });

  it('appends the passphrase field only when provided and never sets Content-Type manually', async () => {
    const withPass = uploadBackup({ file: makeFile(), passphrase: '123456', includeCsrf: false });
    const xhrA = FakeXHR.instances[0]!;
    expect((xhrA.body as FormData).get('passphrase')).toBe('123456');
    expect((xhrA.body as FormData).get('backup')).toBeTruthy();
    xhrA.respond(200, JSON.stringify({ ok: true }));
    await withPass;

    const withoutPass = uploadBackup({ file: makeFile(), includeCsrf: false });
    const xhrB = FakeXHR.instances[1]!;
    expect((xhrB.body as FormData).has('passphrase')).toBe(false);
    expect(xhrB.headers['content-type']).toBeUndefined();
    xhrB.respond(200, JSON.stringify({ ok: true }));
    await withoutPass;
  });

  it('performs no CSRF fetch when includeCsrf is false', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ csrfToken: 'tok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = uploadBackup({ file: makeFile(), includeCsrf: false });
    const xhr = FakeXHR.instances[0]!;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhr.headers['x-csrf-token']).toBeUndefined();
    xhr.respond(200, JSON.stringify({ ok: true }));
    await p;
  });

  it('fetches and attaches the CSRF token when includeCsrf is true (default)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ csrfToken: 'tok-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = uploadBackup({ file: makeFile() });
    // the XHR is created synchronously, but the CSRF header is set after the token fetch resolves
    await vi.waitFor(() => expect(FakeXHR.instances[0]?.headers['x-csrf-token']).toBe('tok-1'));
    const xhr = FakeXHR.instances[0]!;
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/csrf', { credentials: 'include' });
    expect(xhr.headers['x-csrf-token']).toBe('tok-1');
    expect(xhr.withCredentials).toBe(true);
    xhr.respond(200, JSON.stringify({ ok: true, profile: 'compact' }));
    await expect(p).resolves.toMatchObject({ ok: true, profile: 'compact' });
  });
});
