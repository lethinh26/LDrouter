// Root-scope admin-site IP access control (Settings → Access Control).
//
// Gates the ENTIRE admin website (login, setup, static UI, all /api/admin
// endpoints): an IP in the block list, or — when an allow list is configured —
// any IP not covered by it, is rejected with 403 before any route runs.
//
// NOT gated (by design): model-traffic endpoints /v1/* (LLM API requests are
// governed by API keys, not this site access list) and operational endpoints
// (/health, /ready, /metrics) so Docker health checks keep working.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSettings } from '../db/repositories/settings';
import { ipMatchesAny } from '../util/cidr';
import { resolveClientIp } from '../util/client-ip';

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Re-evaluate the current site IP policy for long-lived authenticated streams. */
export function isAdminIpAllowed(req: FastifyRequest): boolean {
  const settings = getSettings();
  const allow = parseList(settings.adminIpAllow);
  const block = parseList(settings.adminIpBlock);
  if (allow.length === 0 && block.length === 0) return true;

  const ip = resolveClientIp(req);
  if (block.length > 0 && ipMatchesAny(ip, block)) return false;
  return allow.length === 0 || ipMatchesAny(ip, allow);
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

    if (!isAdminIpAllowed(req)) {
      reply.code(403).type('text/plain').send('Không có quyền truy cập');
      return;
    }
  });
}
