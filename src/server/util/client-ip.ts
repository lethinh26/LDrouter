// Client-IP resolution: trust X-Forwarded-For only when trustProxyHops > 0.

import type { FastifyRequest } from 'fastify';
import { loadConfig } from '../config/index';

export function resolveClientIp(req: FastifyRequest): string {
  const cfg = loadConfig();
  if (cfg.trustProxyHops > 0) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') {
      const chain = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const idx = Math.max(0, chain.length - cfg.trustProxyHops);
      if (chain[idx]) return chain[idx]!;
    }
  }
  return req.ip || (req.socket?.remoteAddress ?? '0.0.0.0');
}
