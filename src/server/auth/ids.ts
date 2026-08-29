// ID generation helpers — stable random IDs + opaque sortable request IDs.

import crypto from 'node:crypto';

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomBytes(n: number): Buffer {
  return crypto.randomBytes(n);
}

/** Opaque sortable-ish request ID: time (ms) base36 + random suffix. */
export function generateRequestId(): string {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(6).toString('base64url');
  return `req_${t}${r}`;
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Generate a gateway API key: ld-<base64url(32 bytes)> */
export function generateApiKeySecret(): string {
  const payload = crypto.randomBytes(32).toString('base64url');
  return `ld-${payload}`;
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'item'
  );
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
