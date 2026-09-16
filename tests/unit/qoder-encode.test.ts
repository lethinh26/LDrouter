// Unit tests: Qoder request-body obfuscation (`&Encode=1`). Losslessness is the
// contract — a wrong split order still yields plausible-looking base64-ish output,
// so every case is checked through the inverse transform.
import { describe, expect, it } from 'vitest';
import { encodeQoderBody } from '../../src/server/providers/qoder/encode';

const ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Inverse of encodeQoderBody, used to prove the transform is lossless. */
function decodeQoderBody(encoded: string): Buffer {
  const n = encoded.length;
  const a = Math.floor(n / 3);
  const rearranged = Buffer.from([...encoded].map((ch) => {
    const at = ALPHABET.indexOf(ch);
    if (at >= 0) return STD.charCodeAt(at);
    return ch === '$' ? '='.charCodeAt(0) : ch.charCodeAt(0);
  })).toString('latin1');
  // Swapping two equal-size ends is its own inverse, so decoding is the same
  // [tail][mid][head] expression as encoding. (mid+head+tail is NOT the inverse.)
  const standard = rearranged.slice(n - a) + rearranged.slice(a, n - a) + rearranged.slice(0, a);
  return Buffer.from(standard, 'base64');
}

describe('Qoder body encoding', () => {
  it('round-trips an arbitrary payload', () => {
    const payload = Buffer.from(JSON.stringify({ key: 'qmodel_38max', chat_context: { text: 'xin chào 你好' } }), 'utf8');
    expect(decodeQoderBody(encodeQoderBody(payload))).toEqual(payload);
  });

  it('preserves the base64 length', () => {
    for (const size of [0, 1, 2, 3, 10, 64, 1000]) {
      const input = Buffer.alloc(size, 7);
      expect(encodeQoderBody(input)).toHaveLength(Buffer.from(input).toString('base64').length);
    }
  });

  it('emits only characters from the custom alphabet', () => {
    const encoded = encodeQoderBody(Buffer.from('Hello, Qoder! '.repeat(50), 'utf8'));
    expect([...encoded].every((ch) => ALPHABET.includes(ch) || ch === '$')).toBe(true);
  });

  it('is deterministic and input-sensitive', () => {
    expect(encodeQoderBody('same')).toBe(encodeQoderBody('same'));
    expect(encodeQoderBody('same')).not.toBe(encodeQoderBody('different'));
  });

  it('treats string and Buffer inputs identically', () => {
    expect(encodeQoderBody('hello')).toBe(encodeQoderBody(Buffer.from('hello', 'utf8')));
  });
});
