// CIDR matching for IPv4 + IPv6.

import ipaddr from 'ipaddr.js';

export interface ParsedCidr {
  cidr: string;
  family: 'ipv4' | 'ipv6';
  prefix: number;
  matches(ip: string): boolean;
}

export function parseCidr(input: string): ParsedCidr {
  const cidr = input.trim();
  if (!cidr) throw new Error('empty cidr');
  let base: string;
  let prefix: number;
  if (cidr.includes('/')) {
    const parts = cidr.split('/');
    base = parts[0]!;
    prefix = Number(parts[1]);
  } else {
    base = cidr;
    prefix = -1; // -1 = single host, normalized
  }
  const parsed = ipaddr.parse(base);
  const family: 'ipv4' | 'ipv6' = parsed.kind() === 'ipv4' ? 'ipv4' : 'ipv6';
  if (prefix === -1) {
    prefix = family === 'ipv4' ? 32 : 128;
  }
  if (family === 'ipv4' && (prefix < 0 || prefix > 32)) throw new Error('invalid ipv4 prefix');
  if (family === 'ipv6' && (prefix < 0 || prefix > 128)) throw new Error('invalid ipv6 prefix');
  const normalized = `${parsed.toString()}/${prefix}`;
  return {
    cidr: normalized,
    family,
    prefix,
    matches(ip: string): boolean {
      try {
        const addr = ipaddr.parse(ip);
        const addrKind = addr.kind();
        if (addrKind === family) {
          return samePrefix(parsed, addr, prefix);
        }
        // IPv4-mapped IPv6 (::ffff:a.b.c.d) satisfies IPv4 CIDR rules.
        if (family === 'ipv4' && addrKind === 'ipv6') {
          const v4 = (addr as ipaddr.IPv6).toIPv4Address();
          if (!v4) return false;
          return samePrefix(parsed, v4, prefix);
        }
        return false;
      } catch {
        return false;
      }
    },
  };
}

function samePrefix(a: ipaddr.IPv4 | ipaddr.IPv6, b: ipaddr.IPv4 | ipaddr.IPv6, prefix: number): boolean {
  const aBytes = octets(a);
  const bBytes = octets(b);
  const full = aBytes.length * 8;
  if (prefix === 0) return true;
  if (prefix >= full) return a.toString() === b.toString();
  const fullBytes = Math.floor(prefix / 8);
  const remBits = prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (aBytes[i] !== bBytes[i]) return false;
  }
  if (remBits === 0) return true;
  const mask = (0xff << (8 - remBits)) & 0xff;
  return (aBytes[fullBytes]! & mask) === (bBytes[fullBytes]! & mask);
}

function octets(a: ipaddr.IPv4 | ipaddr.IPv6): number[] {
  if (a.kind() === 'ipv4') {
    return (a as ipaddr.IPv4).toByteArray();
  }
  return (a as ipaddr.IPv6).toByteArray();
}

export function ipMatchesAny(ip: string, cidrs: string[]): boolean {
  for (const c of cidrs) {
    try {
      const parsed = parseCidr(c);
      if (parsed.matches(ip)) return true;
    } catch {
      // ignore invalid cidr
    }
  }
  return false;
}
