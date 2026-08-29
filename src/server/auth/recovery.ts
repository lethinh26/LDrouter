// Recovery code generator.

import crypto from 'node:crypto';

export function generateRecoveryCodes(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const b = crypto.randomBytes(6);
    const groups = [b.subarray(0, 3), b.subarray(3, 6)];
    out.push(groups.map((g) => g.toString('hex').toUpperCase()).join('-'));
  }
  return out;
}
