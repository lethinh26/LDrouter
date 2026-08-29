// Fastify application factory.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/index';
import { getLogger } from './logging/logger';
import { openDb, closeDb, getDb, schema } from './db/index';
import { getSettings, markSetupComplete } from './db/repositories/settings';
import { GatewayError, toAnthropicError, toOpenAIError } from './errors';
import { ZodError } from 'zod';
import { generateRequestId } from './auth/ids';
import { recordAudit } from './db/repositories/audit';
import { isMasterKeyConfigured } from './auth/crypto';
import { registerAdminRoutes } from './routes/admin';
import { registerGatewayRoutes } from './routes/gateway';
import { registerHealthRoutes } from './routes/health';
import { metricsRegistry } from './metrics/registry';
type App = FastifyInstance;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  skipOpenDb?: boolean;
}

export async function buildApp(opts: AppOptions = {}): Promise<App> {
  const cfg = loadConfig();
  const log = getLogger();
  if (!opts.skipOpenDb) openDb(cfg.dbFile);

  // Initialize metrics registry after logger is available
  metricsRegistry.init(log);

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: cfg.trustProxyHops > 0,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => (req.headers['x-request-id'] as string) || generateRequestId(),
    disableRequestLogging: false,
  } as never) as unknown as App;

  await app.register(cookie, { secret: cfg.masterKey ?? 'latedev-dev-secret' });
  await app.register(helmet, {
    contentSecurityPolicy: false, // we set a permissive one for the admin UI inline bootstrap
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, { origin: false, credentials: true });

  // Per-request logging + error shaping
  app.addHook('onResponse', async (req, reply) => {
    reply.header('x-request-id', req.id as string);
  });

  app.setErrorHandler((err: unknown, req: { id: string | number; headers: Record<string, string | string[] | undefined>; url: string; log: { error: (o: object, m: string) => void; warn: (o: object, m: string) => void } }, reply: { code: (n: number) => { send: (v: unknown) => void }; send: (v: unknown) => void }) => {
    // Zod validation failures surface as 400 with readable field messages;
    // otherwise they fall through to the generic 500 "Gateway error" envelope.
    const normalized = err instanceof ZodError
      ? new GatewayError('invalid_request_error', err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), { status: 400 })
      : err;
    const g = normalized instanceof GatewayError ? normalized : null;
    const status = g?.status ?? 500;
    const requestId = req.id as string;
    // Fastify runs with `logger: false`, so req.log is a silent no-op — use the app
    // logger so failures actually show up in `docker logs`.
    const log = getLogger();
    const errMsg = normalized instanceof Error ? normalized.message : String(normalized);
    const errDetail = {
      name: normalized instanceof Error ? normalized.name : undefined,
      message: errMsg,
      stack: normalized instanceof Error ? normalized.stack : undefined,
    };
    if (status >= 500) log.error({ requestId, url: req.url, err: errDetail }, 'request error');
    else log.warn({ requestId, url: req.url, err: { type: (g?.type ?? 'error'), message: errMsg } }, 'request rejected');

    const accept = (req.headers['accept'] ?? '').toString();
    const isAnthropic = accept.includes('application/vnd.anthropic') || req.url.includes('/v1/messages');
    if (g) {
      reply.code(status).send(isAnthropic ? toAnthropicError(g, requestId) : toOpenAIError(g, requestId));
      return;
    }
    const e: GatewayError = new GatewayError('gateway_error', 'Internal gateway error', { safe: false, cause: err });
    reply.code(500).send(isAnthropic ? toAnthropicError(e, requestId) : toOpenAIError(e, requestId));
  });

  // Static admin UI (if built). The not-found handler is registered once:
  // with a built UI it serves the SPA index.html for non-API paths; without it,
  // every miss returns a JSON 404 in the requesting protocol's shape.
  const webDist = path.resolve(__dirname, '../web');
  const hasWeb = fs.existsSync(webDist);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/v1') || req.url.startsWith('/health') || req.url.startsWith('/ready') || req.url.startsWith('/metrics') || !hasWeb) {
      const e = new GatewayError('invalid_request_error', 'Route not found', { status: 404 });
      reply.code(404).send(toOpenAIError(e, req.id as string));
      return;
    }
    reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
  });

  if (hasWeb) {
    await app.register(staticPlugin, { root: webDist, prefix: '/', decorateReply: false });
  }

  // Operational routes (always available)
  await registerHealthRoutes(app);

  // Admin + gateway routes
  await registerAdminRoutes(app);
  await registerGatewayRoutes(app);

  // On startup: ensure settings row + detect master key status
  app.addHook('onReady', async () => {
    const s = getSettings();
    if (!s.masterKeyConfigured && isMasterKeyConfigured()) {
      getDb()
        .update(schema.appSettings)
        .set({ masterKeyConfigured: true })
        .where(sql`id=1`)
        .run();
    }
    if (s.setupComplete) {
      log.info({ dbFile: cfg.dbFile }, 'LateDev Router ready');
    } else {
      log.info({ dbFile: cfg.dbFile }, 'LateDev Router ready (first-run setup required)');
    }
  });

  return app;
}

export async function startApp(): Promise<App> {
  const cfg = loadConfig();
  const app = await buildApp();
  const close = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      closeDb();
    }
  };
  process.once('SIGTERM', () => void close('SIGTERM'));
  process.once('SIGINT', () => void close('SIGINT'));
  await app.listen({ host: cfg.host, port: cfg.port });
  return app;
}

// re-export for convenience
import { sql } from 'drizzle-orm';
export { recordAudit, markSetupComplete };
