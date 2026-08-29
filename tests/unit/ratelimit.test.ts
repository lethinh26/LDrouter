// Unit tests: rate limit buckets.
import { describe, expect, it } from 'vitest';
import { checkRpm, checkTpm, acquireConcurrent, releaseConcurrent } from '../../src/server/routing/ratelimit';

describe('rate limits', () => {
  it('RPM bucket allows then denies', () => {
    // rpm limit 2: two allowed, third denied
    expect(checkRpm('k1', 2).allowed).toBe(true);
    expect(checkRpm('k1', 2).allowed).toBe(true);
    const third = checkRpm('k1', 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('no limit = always allowed', () => {
    expect(checkRpm('k2', null).allowed).toBe(true);
    expect(checkTpm('k2', null, 9999).allowed).toBe(true);
  });

  it('TPM denies when over', () => {
    expect(checkTpm('k3', 10, 8).allowed).toBe(true);
    expect(checkTpm('k3', 10, 8).allowed).toBe(false);
  });

  it('concurrency acquire/release', () => {
    expect(acquireConcurrent('k4', 2)).toBe(true);
    expect(acquireConcurrent('k4', 2)).toBe(true);
    expect(acquireConcurrent('k4', 2)).toBe(false);
    releaseConcurrent('k4');
    expect(acquireConcurrent('k4', 2)).toBe(true);
    releaseConcurrent('k4');
    releaseConcurrent('k4');
  });
});
