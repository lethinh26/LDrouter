// Qoder request-body obfuscation for `&Encode=1`: standard base64, split into thirds
// and reordered [tail][mid][head], then mapped through a custom 64-char alphabet.
// Second-order WAF evasion, not security: the transform is public and reversible.
// Pure and log-free — the plaintext is request content, so never echo it.

const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';

const S2C = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i += 1) table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  table['='.charCodeAt(0)] = '$'.charCodeAt(0);
  return table;
})();

/** Encode a request body so the upstream can decode it with `&Encode=1`. */
export function encodeQoderBody(plaintext: Buffer | Uint8Array | string): string {
  const buf = Buffer.isBuffer(plaintext) ? plaintext : typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const standard = buf.toString('base64');
  const n = standard.length;
  const a = Math.floor(n / 3);
  const rearranged = standard.slice(n - a) + standard.slice(a, n - a) + standard.slice(0, a);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) {
    const code = rearranged.charCodeAt(i);
    const mapped = code < 128 ? S2C[code] ?? -1 : -1;
    out[i] = mapped >= 0 ? mapped : code;
  }
  return out.toString('latin1');
}
