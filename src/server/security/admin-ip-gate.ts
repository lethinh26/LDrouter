// Root-scope admin-site IP access control (Settings → Access Control).
//
// Gates the ENTIRE admin website (login, setup, static UI, all /api/admin
// endpoints): an IP in the block list, or — when an allow list is configured —
// any IP not covered by it, is rejected with 403 before any route runs.
//
// NOT gated (by design): model-traffic endpoints /v1/* (LLM API requests are
// governed by API keys, not this site access list) and operational endpoints
// (/health, /ready, /metrics) so Docker health checks keep working.

import type { FastifyInstance } from 'fastify';
import { getSettings } from '../db/repositories/settings';
import { ipMatchesAny } from '../util/cidr';
import { resolveClientIp } from '../util/client-ip';

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function registerAdminIpGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0] ?? req.url;
    // Operational + model-traffic endpoints are exempt.
    if (
      url === '/health' || url.startsWith('/health/') ||
      url === '/ready' || url.startsWith('/ready/') ||
      url === '/metrics' || url.startsWith('/metrics/') ||
      url.startsWith('/v1/') || url === '/v1'
    ) return;

    const s = getSettings();
    const allow = parseList(s.adminIpAllow);
    const block = parseList(s.adminIpBlock);
    if (allow.length === 0 && block.length === 0) return; // feature disabled

    const ip = resolveClientIp(req);
    if (block.length > 0 && ipMatchesAny(ip, block)) {
      reply.code(403).type('text/plain').send('Không có quyền truy cập');
      return;
    }
    if (allow.length > 0 && !ipMatchesAny(ip, allow)) {
      reply.code(403).type('text/plain').send('Không có quyền truy cập');
      return;
    }
  });
}
