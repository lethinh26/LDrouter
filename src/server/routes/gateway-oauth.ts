// Local gateway issuer. Admin routes are registered in the existing
// authenticated/CSRF-protected admin scope; the token route is public.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GatewayOAuthError, authorizeGatewayOAuth, exchangeGatewayOAuthToken, gatewayOAuthSecureTransport,
  listGatewayOAuthGrants, listGatewayOAuthKeys, revokeGatewayOAuthGrant } from '../auth/gateway-oauth';
import { resolveClientIp } from '../util/client-ip';

const BODY_LIMIT = 8192;
const FORM_TYPE = /^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i;

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

function parseForm(value: unknown): Map<string, string> {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > BODY_LIMIT) throw new GatewayOAuthError('invalid_request');
  const result = new Map<string, string>();
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    for (const field of text.split('&')) {
      const sep = field.indexOf('=');
      if (sep < 1 || result.size >= 6) throw new GatewayOAuthError('invalid_request');
      const key = decode(field.slice(0, sep));
      if (!key || /[^a-z_]/.test(key) || result.has(key)) throw new GatewayOAuthError('invalid_request');
      result.set(key, decode(field.slice(sep + 1)));
    }
  } catch { throw new GatewayOAuthError('invalid_request'); }
  return result;
}

function publicError(reply: FastifyReply, error: unknown) {
  const safe = error instanceof GatewayOAuthError ? error : new GatewayOAuthError('server_error', 500);
  return noStore(reply).code(safe.status).send({ error: safe.code });
}

function adminError(reply: FastifyReply, error: unknown) {
  const safe = error instanceof GatewayOAuthError ? error : new GatewayOAuthError('server_error', 500);
  return noStore(reply).code(safe.status).send({ error: { type: safe.status >= 500 ? 'gateway_error' : 'invalid_request_error', code: safe.code, message: safe.code } });
}

export async function registerGatewayOAuthAdminRoutes(app: FastifyInstance): Promise<void> {
  const onRequest = async (_req: FastifyRequest, reply: FastifyReply) => { noStore(reply); };
  app.post('/api/admin/gateway-oauth/authorize', { bodyLimit: BODY_LIMIT, onRequest }, async (req, reply) => {
    try {
      if (!gatewayOAuthSecureTransport(req)) throw new GatewayOAuthError('secure_transport_required', 400);
      return reply.send(authorizeGatewayOAuth(req.body, req.adminSessionId, resolveClientIp(req)));
    } catch (error) { return adminError(reply, error); }
  });
  app.get('/api/admin/gateway-oauth/keys', { onRequest }, async (req, reply) => {
    try {
      if (!req.adminSessionId) throw new GatewayOAuthError('invalid_session', 401);
      return reply.send({ keys: listGatewayOAuthKeys() });
    } catch (error) { return adminError(reply, error); }
  });
  app.get('/api/admin/gateway-oauth/grants', { onRequest }, async (req, reply) => {
    try {
      if (!req.adminSessionId) throw new GatewayOAuthError('invalid_session', 401);
      return reply.send({ grants: listGatewayOAuthGrants() });
    } catch (error) { return adminError(reply, error); }
  });
  app.delete('/api/admin/gateway-oauth/grants/:id', { onRequest }, async (req, reply) => {
    try {
      if (!req.adminSessionId) throw new GatewayOAuthError('invalid_session', 401);
      revokeGatewayOAuthGrant((req.params as { id: string }).id, resolveClientIp(req));
      return reply.send({ ok: true });
    } catch (error) { return adminError(reply, error); }
  });
}

export async function registerGatewayOAuthTokenRoutes(app: FastifyInstance): Promise<void> {
  // The parser, errors and body limit apply only to this isolated endpoint,
  // not to JSON gateway traffic or other Fastify routes.
  await app.register(async scope => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => {
      try { done(null, parseForm(body)); }
      catch (error) { done(error as Error); }
    });
    scope.setErrorHandler((error, _req, reply) => {
      if (error instanceof GatewayOAuthError) return publicError(reply, error);
      const status = error !== null && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
      if (status === 413 || status === 415) return publicError(reply, new GatewayOAuthError('invalid_request', status));
      return publicError(reply, new GatewayOAuthError(status && status < 500 ? 'invalid_request' : 'server_error', status && status < 500 ? 400 : 500));
    });
    scope.post('/api/oauth/token', {
      bodyLimit: BODY_LIMIT,
      onRequest: async (req, reply) => {
        noStore(reply);
        if (req.url.includes('?')) return publicError(reply, new GatewayOAuthError('invalid_request'));
        if (!gatewayOAuthSecureTransport(req)) return publicError(reply, new GatewayOAuthError('invalid_request'));
        if (typeof req.headers['content-type'] !== 'string' || !FORM_TYPE.test(req.headers['content-type'])) {
          return publicError(reply, new GatewayOAuthError('invalid_request', 415));
        }
        if (req.headers.authorization !== undefined) return publicError(reply, new GatewayOAuthError('invalid_client'));
      },
    }, async (req, reply) => {
      try {
        if (!(req.body instanceof Map)) throw new GatewayOAuthError('invalid_request');
        return reply.send(exchangeGatewayOAuthToken(req.body, resolveClientIp(req)));
      } catch (error) { return publicError(reply, error); }
    });
  });
}
