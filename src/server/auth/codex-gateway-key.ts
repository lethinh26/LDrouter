// LDrouter-issued OAuth is a separate gateway credential, never an upstream
// credential. Resolve it to the original gateway key so accounting, quotas,
// IP policy and model permissions use exactly the existing identity.
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { getDb, getDatabaseEpoch, schema } from '../db/index';
import { GatewayError } from '../errors';
import { resolveClientIp } from '../util/client-ip';
import { keyIpAllowed, keyIsActive, requireGatewayKey, type AuthenticatedKey } from './api-key';
import { gatewayOAuthSecureTransport, resolveGatewayOAuthAccess } from './gateway-oauth';

export interface CodexGatewayCredential {
  key: AuthenticatedKey;
  oauthStillActive?: () => boolean;
}

export function requireCodexGatewayKey(req: FastifyRequest): CodexGatewayCredential {
  const header = req.headers['x-gateway-token'];
  const invalid = () => new GatewayError('authentication_error', 'Invalid or expired gateway OAuth credential', { status: 401, code: 'gateway_oauth_invalid' });
  if (header === undefined) {
    if (req.headers['x-api-key'] !== undefined && typeof req.headers['x-api-key'] !== 'string') throw invalid();
    return { key: requireGatewayKey(req, 'x-api-key') };
  }
  if (req.headers['x-api-key'] !== undefined || typeof header !== 'string' || !gatewayOAuthSecureTransport(req)) throw invalid();
  const token = /^Bearer (ldo-a-[A-Za-z0-9_-]{43})$/i.exec(header)?.[1];
  if (!token) throw invalid();
  const grant = resolveGatewayOAuthAccess(token);
  if (!grant) throw invalid();
  const row = getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, grant.keyId)).get();
  if (!row || row.keyDigest !== grant.keyDigest || !keyIsActive(row)) throw invalid();
  const clientIp = resolveClientIp(req);
  if (!keyIpAllowed(row.id, clientIp)) throw new GatewayError('permission_error', 'IP address not permitted for this API key', { status: 403 });
  const epoch = getDatabaseEpoch();
  const key: AuthenticatedKey = {
    id: row.id, name: row.name, keyPrefix: row.keyPrefix,
    enabled: row.enabled, expiresAt: row.expiresAt, allowAllModels: row.allowAllModels,
    rpmLimit: row.rpmLimit, tpmLimit: row.tpmLimit, dailyTokenLimit: row.dailyTokenLimit,
    monthlyTokenLimit: row.monthlyTokenLimit, totalTokenLimit: row.totalTokenLimit,
    maxConcurrent: row.maxConcurrent, maxOutputTokensPerRequest: row.maxOutputTokensPerRequest,
    cacheOverrideEnabled: row.cacheOverrideEnabled,
  };
  getDb().update(schema.apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(schema.apiKeys.id, row.id)).run();
  return {
    key,
    oauthStillActive: () => {
      if (epoch !== getDatabaseEpoch()) return false;
      const fresh = resolveGatewayOAuthAccess(token);
      return fresh?.grantId === grant.grantId && fresh.keyId === grant.keyId &&
        fresh.keyDigest === grant.keyDigest && keyIpAllowed(grant.keyId, clientIp);
    },
  };
}
