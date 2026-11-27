// Subscription observations are an admin-only monitoring registry, not
// provider credentials, live entitlement, routing inputs or local token caps.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getDatabaseEpoch, getRawDb } from '../../db/index';
import { sha256Hex, timingSafeEqualHex, uuid } from '../../auth/ids';
import { gatewayOAuthSecureTransport } from '../../auth/gateway-oauth';
import { GatewayError, toOpenAIError } from '../../errors';
import { redactString } from '../../security/redact';

const MAX_ACCOUNTS = 256;
const MAX_WINDOWS = 32;
const BODY_LIMIT = 32 * 1024;
const path = '/api/admin/subscription-quotas';
const fail = (message = 'Invalid quota data', status = 400) => new GatewayError('invalid_request_error', message, { status });
const safeText = (max: number) => z.string().trim().min(1).max(max)
  .refine(s => !Array.from(s).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && redactString(s) === s);
const timestamp = z.string().datetime({ offset: true }).refine(s => Number.isFinite(Date.parse(s)) && Date.parse(s) > 0)
  .transform(s => new Date(s).toISOString());
const provider = z.enum(['codex', 'claude_code']);
const name = safeText(128);
const percent = z.number().finite().min(0).max(100);
const minutes = z.number().int().positive().max(525600);
const plan = safeText(64).nullable();
const windowSchema = z.object({
  label: safeText(128), usedPercent: percent,
  windowDurationMins: minutes.nullable(), resetsAt: timestamp.nullable(),
}).strict();
const snapshotSchema = z.object({
  source: z.enum(['manual', 'codex_app_server', 'codex_client_sync']),
  observedAt: timestamp, plan,
  ordinaryUsageAllowed: z.boolean().nullable(),
  windows: z.array(windowSchema).max(MAX_WINDOWS),
}).strict();
const manualSchema = z.object({
  source: z.literal('manual'), observedAt: timestamp, plan,
  windows: z.array(windowSchema).min(1).max(MAX_WINDOWS),
}).strict();
// The documented app-server result is extensible; select only recognized
// quota fields and discard credits, banners, arbitrary metadata, etc.
const nativeWindow = z.object({
  usedPercent: percent, windowDurationMins: minutes.nullish(),
  resetsAt: z.number().int().positive().max(253402300799).nullish(),
});
const nativeBucket = z.object({
  limitId: safeText(80).nullish(), limitName: safeText(80).nullish(),
  planType: safeText(64).nullish(),
  primary: nativeWindow.nullish(), secondary: nativeWindow.nullish(),
});
const nativeResult = z.object({
  accountId: z.string().min(1).max(256).refine(s => /^[A-Za-z0-9_-]+$/.test(s)).nullish(),
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimits: nativeBucket,
  rateLimitsByLimitId: z.record(safeText(80), nativeBucket).nullish(),
});
const importSchema = z.object({
  source: z.literal('codex_app_server'), observedAt: timestamp, result: nativeResult,
}).strict();
const syncSchema = z.object({
  observedAt: timestamp, accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  result: nativeResult.omit({ accountId: true }).strict(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Row = {
  id: string; provider_kind: 'codex' | 'claude_code'; name: string;
  account_fingerprint: string | null; snapshot_json: string | null;
  created_at_ms: number; updated_at_ms: number;
};
type Db = ReturnType<typeof getRawDb>;

function validated<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw fail();
  return result.data;
}

function readSnapshot(row: Row): Snapshot | null {
  if (row.snapshot_json === null) return null;
  try {
    // Also constrain metadata restored from backups. No unknown fields leak.
    return validated(snapshotSchema, JSON.parse(row.snapshot_json));
  } catch { throw new GatewayError('gateway_error', 'Stored quota snapshot is invalid', { status: 500 }); }
}

function normalize(value: unknown, row: Row, clientFingerprint?: string): { snapshot: Snapshot; fingerprint: string | null } {
  const source = (value as { source?: unknown } | null)?.source;
  let fingerprint = row.account_fingerprint;
  let snapshot: Snapshot;
  if (source === 'manual') {
    const input = validated(manualSchema, value);
    snapshot = { ...input, ordinaryUsageAllowed: null };
  } else if (source === 'codex_app_server' && row.provider_kind === 'codex') {
    const { observedAt, result } = validated(importSchema, value);
    const imported = clientFingerprint ?? (result.accountId ? sha256Hex(result.accountId) : null);
    if (fingerprint !== null && fingerprint !== imported) throw fail('Imported account does not match this record', 409);
    fingerprint = imported;
    const buckets = Object.entries(result.rateLimitsByLimitId ?? {});
    if (buckets.length > 16) throw fail();
    const selected = buckets.length ? buckets : [[result.rateLimits.limitId ?? 'codex', result.rateLimits] as const];
    const windows: Snapshot['windows'] = [];
    const plans = new Set<string>();
    for (const [id, bucket] of selected) {
      if (bucket.planType) plans.add(bucket.planType);
      for (const key of ['primary', 'secondary'] as const) {
        const w = bucket[key];
        if (!w) continue;
        windows.push({
          label: `${id} / ${key}`,
          usedPercent: w.usedPercent,
          windowDurationMins: w.windowDurationMins ?? null,
          resetsAt: w.resetsAt == null ? null : new Date(w.resetsAt * 1000).toISOString(),
        });
      }
    }
    snapshot = { source: clientFingerprint ? 'codex_client_sync' : source, observedAt, plan: plans.size === 1 ? [...plans][0]! : null,
      ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null, windows };
  } else { throw fail(); }
  if (new Set(snapshot.windows.map(w => w.label.toLowerCase())).size !== snapshot.windows.length) throw fail('Duplicate quota window labels');
  if (Date.parse(snapshot.observedAt) > Date.now() + 300_000) throw fail('Observation time is in the future');
  const old = readSnapshot(row);
  if (old && Date.parse(snapshot.observedAt) < Date.parse(old.observedAt)) throw fail('Observation is older than the stored snapshot', 409);
  return { snapshot: validated(snapshotSchema, snapshot), fingerprint };
}

function lookup(db: Db, id: unknown): Row {
  const key = validated(z.string().uuid(), id);
  const row = db.prepare('SELECT * FROM subscription_quota_accounts WHERE id=?').get(key) as Row | undefined;
  if (!row) throw fail('Quota account not found', 404);
  return row;
}

function assertUnique(db: Db, kind: string, label: string, id = '', fingerprint: string | null = null) {
  if (db.prepare('SELECT 1 FROM subscription_quota_accounts WHERE provider_kind=? AND name=? COLLATE NOCASE AND id<>?').get(kind, label, id)) {
    throw fail('Quota account name already exists', 409);
  }
  if (fingerprint && db.prepare('SELECT 1 FROM subscription_quota_accounts WHERE provider_kind=? AND account_fingerprint=? AND id<>?').get(kind, fingerprint, id)) {
    throw fail('Imported identity already belongs to another quota record', 409);
  }
}

function audit(db: Db, operation: 'create' | 'rename' | 'observe' | 'delete' | 'sync_pair' | 'sync_revoke', id: string, req: FastifyRequest) {
  db.prepare("INSERT INTO audit_logs(id,action,actor,ip,success,target_type,target_id) VALUES (?,?, 'admin', ?,1,'subscription_quota',?)")
    .run(uuid(), 'subscription_quota.' + operation, req.ip, id);
}

// A pairing is a temporary, write-only capability, not provider authorization.
// Keep digests in process memory only: no secret in SQLite, backups or logs.
const SYNC_TTL = 24 * 60 * 60_000;
const SYNC_MIN_INTERVAL = 60_000;
type SyncGrant = { digest: string; epoch: string; expiresAt: number; lastSyncedAt: number | null };
const syncGrants = new Map<string, SyncGrant>();

function pruneSyncGrants() {
  const epoch = getDatabaseEpoch(), now = Date.now();
  for (const [id, grant] of syncGrants) {
    if (!epoch || grant.epoch !== epoch || grant.expiresAt <= now) syncGrants.delete(id);
  }
}

function syncMetadata(id: string) {
  const grant = syncGrants.get(id);
  return grant ? { expiresAt: new Date(grant.expiresAt).toISOString(),
    lastSyncedAt: grant.lastSyncedAt === null ? null : new Date(grant.lastSyncedAt).toISOString() } : null;
}

function requireSyncGrant(req: FastifyRequest): SyncGrant {
  pruneSyncGrants();
  const id = (req.params as { id?: string }).id;
  const header = req.headers.authorization;
  const grant = id ? syncGrants.get(id) : undefined;
  const match = typeof header === 'string' ? /^Bearer (ldq-[A-Za-z0-9_-]{43})$/.exec(header) : null;
  if (!gatewayOAuthSecureTransport(req) || !grant || !match || !timingSafeEqualHex(sha256Hex(match[1]!), grant.digest)) {
    throw new GatewayError('authentication_error', 'Invalid or expired quota pairing', { status: 401 });
  }
  return grant;
}

/** Public transport, authenticated solely by the account-scoped pairing.
 * No admin cookie, gateway key or upstream credential grants this capability. */
export async function registerQuotaSyncRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async scope => {
    scope.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
    scope.setErrorHandler((err, req, reply) => {
      const status = err instanceof GatewayError ? err.status : (err as { statusCode?: number }).statusCode;
      const safe = err instanceof GatewayError ? err : status && status >= 400 && status < 500 ? fail('Invalid quota sync request', status) :
        new GatewayError('gateway_error', 'Quota sync failed', { status: 500 });
      return reply.code(safe.status).send(toOpenAIError(safe, req.id));
    });
    scope.post('/api/quota-sync/:id', { bodyLimit: BODY_LIMIT, onRequest: async req => { requireSyncGrant(req); } }, async req => {
      // Check again after parsing: revocation/rotation/restore may have happened.
      const grant = requireSyncGrant(req);
      const now = Date.now();
      if (grant.lastSyncedAt !== null && now - grant.lastSyncedAt < SYNC_MIN_INTERVAL) {
        throw new GatewayError('rate_limit_error', 'Quota sync is limited to one observation per minute', { status: 429 });
      }
      const input = validated(syncSchema, req.body);
      const observed = Date.parse(input.observedAt);
      if (observed < now - 10 * 60_000 || observed > now + 60_000) throw fail('Quota sync observation is outside the allowed time window');
      const db = getRawDb();
      db.transaction(() => {
        const row = lookup(db, (req.params as { id: string }).id);
        if (row.provider_kind !== 'codex') throw fail('Quota sync is only supported for Codex', 409);
        const { snapshot, fingerprint } = normalize({ source: 'codex_app_server', observedAt: input.observedAt, result: input.result }, row, input.accountFingerprint);
        assertUnique(db, row.provider_kind, row.name, row.id, fingerprint);
        db.prepare('UPDATE subscription_quota_accounts SET account_fingerprint=?,snapshot_json=?,updated_at_ms=max(created_at_ms,?) WHERE id=?')
          .run(fingerprint, JSON.stringify(snapshot), now, row.id);
      }).immediate();
      grant.lastSyncedAt = now;
      return { ok: true };
    });
  });
}

export async function registerQuotaRegistryRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async scope => {
    scope.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
    // Do not propagate untrusted parser errors, raw imported payloads or
    // database error details to logs or responses. Auth/CSRF is inherited.
    scope.setErrorHandler((err, req, reply) => {
      const status = err instanceof GatewayError ? err.status :
        err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const safe = err instanceof GatewayError ? err : status >= 400 && status < 500 ? fail('Invalid quota request', status) :
        new GatewayError('gateway_error', 'Quota request failed', { status: 500 });
      return reply.code(safe.status).send(toOpenAIError(safe, req.id));
    });
    scope.get(path, async () => {
      pruneSyncGrants();
      const rows = getRawDb().prepare('SELECT * FROM subscription_quota_accounts ORDER BY provider_kind,name,id LIMIT ?').all(MAX_ACCOUNTS) as Row[];
      return { accounts: rows.map(r => ({
        id: r.id, providerKind: r.provider_kind, name: r.name,
        createdAt: new Date(r.created_at_ms).toISOString(), updatedAt: new Date(r.updated_at_ms).toISOString(),
        identityBound: r.account_fingerprint !== null, snapshot: readSnapshot(r), sync: syncMetadata(r.id),
      })) };
    });
    scope.post(path, { bodyLimit: BODY_LIMIT }, async req => {
      const input = validated(z.object({ providerKind: provider, name }).strict(), req.body);
      const db = getRawDb();
      return db.transaction(() => {
        const count = db.prepare('SELECT count(*) AS n FROM subscription_quota_accounts').get() as { n: number };
        if (count.n >= MAX_ACCOUNTS) throw fail('Quota account limit reached', 409);
        assertUnique(db, input.providerKind, input.name);
        const id = uuid(), now = Date.now();
        db.prepare('INSERT INTO subscription_quota_accounts(id,provider_kind,name,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)')
          .run(id, input.providerKind, input.name, now, now);
        audit(db, 'create', id, req);
        return { id };
      }).immediate();
    });
    scope.patch(path + '/:id', { bodyLimit: BODY_LIMIT }, async req => {
      const input = validated(z.object({ name }).strict(), req.body);
      const db = getRawDb();
      return db.transaction(() => {
        const row = lookup(db, (req.params as { id: string }).id);
        assertUnique(db, row.provider_kind, input.name, row.id);
        db.prepare('UPDATE subscription_quota_accounts SET name=?,updated_at_ms=max(created_at_ms,?) WHERE id=?').run(input.name, Date.now(), row.id);
        audit(db, 'rename', row.id, req);
        return { ok: true };
      }).immediate();
    });
    scope.post(path + '/:id/snapshot', { bodyLimit: BODY_LIMIT }, async req => {
      const db = getRawDb();
      return db.transaction(() => {
        const row = lookup(db, (req.params as { id: string }).id);
        const { snapshot, fingerprint } = normalize(req.body, row);
        assertUnique(db, row.provider_kind, row.name, row.id, fingerprint);
        db.prepare('UPDATE subscription_quota_accounts SET account_fingerprint=?,snapshot_json=?,updated_at_ms=max(created_at_ms,?) WHERE id=?')
          .run(fingerprint, JSON.stringify(snapshot), Date.now(), row.id);
        audit(db, 'observe', row.id, req);
        return { ok: true };
      }).immediate();
    });
    scope.post(path + '/:id/sync', { bodyLimit: 1024 }, async req => {
      if (!gatewayOAuthSecureTransport(req)) throw fail('Secure transport is required for pairing', 403);
      const db = getRawDb();
      const row = lookup(db, (req.params as { id: string }).id);
      if (row.provider_kind !== 'codex') throw fail('Quota sync is only supported for Codex', 409);
      pruneSyncGrants();
      if (!syncGrants.has(row.id) && syncGrants.size >= MAX_ACCOUNTS) throw fail('Quota pairing limit reached', 409);
      const token = 'ldq-' + randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + SYNC_TTL;
      audit(db, 'sync_pair', row.id, req);
      syncGrants.set(row.id, { digest: sha256Hex(token), epoch: getDatabaseEpoch(), expiresAt, lastSyncedAt: null });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    });
    scope.delete(path + '/:id/sync', async req => {
      const db = getRawDb();
      const row = lookup(db, (req.params as { id: string }).id);
      audit(db, 'sync_revoke', row.id, req);
      syncGrants.delete(row.id);
      return { ok: true };
    });
    scope.delete(path + '/:id', async req => {
      const db = getRawDb();
      const result = db.transaction(() => {
        const row = lookup(db, (req.params as { id: string }).id);
        db.prepare('DELETE FROM subscription_quota_accounts WHERE id=?').run(row.id);
        audit(db, 'delete', row.id, req);
        return { ok: true };
      }).immediate();
      syncGrants.delete((req.params as { id: string }).id);
      return result;
    });
  });
}
