// Unit tests: API key generation/hash.
import { describe, expect, it } from 'vitest';
import { generateApiKeySecret, sha256Hex } from '../../src/server/auth/ids';

describe('api keys', () => {
  it('generates ld- prefixed keys with 32 bytes of entropy', () => {
    const k = generateApiKeySecret();
    expect(k.startsWith('ld-')).toBe(true);
    const payload = k.slice(3);
    expect(payload.length).toBeGreaterThanOrEqual(40); // base64url of 32 bytes = 43 chars
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically', () => {
    expect(sha256Hex('a')).toBe(sha256Hex('a'));
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
    expect(sha256Hex('a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys', () => {
    const s = new Set(Array.from({ length: 100 }, () => generateApiKeySecret()));
    expect(s.size).toBe(100);
  });
});
