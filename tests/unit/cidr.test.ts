// Unit tests: CIDR parsing/matching IPv4 + IPv6.
import { describe, expect, it } from 'vitest';
import { parseCidr, ipMatchesAny } from '../../src/server/util/cidr';

describe('parseCidr', () => {
  it('matches exact IPv4', () => {
    const r = parseCidr('192.168.1.10');
    expect(r.prefix).toBe(32);
    expect(r.matches('192.168.1.10')).toBe(true);
    expect(r.matches('192.168.1.11')).toBe(false);
  });

  it('matches IPv4 subnet', () => {
    const r = parseCidr('10.0.0.0/8');
    expect(r.matches('10.1.2.3')).toBe(true);
    expect(r.matches('11.0.0.1')).toBe(false);
  });

  it('matches IPv6 subnet', () => {
    const r = parseCidr('2001:db8::/32');
    expect(r.matches('2001:db8::1')).toBe(true);
    expect(r.matches('2001:db9::1')).toBe(false);
  });

  it('handles IPv4-mapped IPv6', () => {
    const r = parseCidr('192.168.1.0/24');
    expect(r.matches('::ffff:192.168.1.5')).toBe(true);
  });

  it('ipMatchesAny', () => {
    expect(ipMatchesAny('10.0.0.5', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(true);
    expect(ipMatchesAny('8.8.8.8', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(false);
  });
});
