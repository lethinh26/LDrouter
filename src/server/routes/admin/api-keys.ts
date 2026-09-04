// Admin API: API key management (ld-.. keys).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index';
import { requireAdminAuth } from '../../auth/middleware';
import { recordAudit } from '../../db/repositories/audit';
import { generateApiKeySecret, sha256Hex, uuid } from '../../auth/ids';
import { encryptSecret, decryptSecret } from '../../auth/crypto';
import { GatewayError } from '../../errors';

/** Decrypt an API key secret, tolerating keys that were encrypted with a
 *  different master key (e.g. after restoring a backup from another
 *  instance). A failed decrypt yields `null` instead of crashing the whole
 *  key list/detail request. */
function safeDecrypt(payload: { ciphertext: string; nonce: string; version: number }): string | null {
  try {
    return decryptSecret(payload);
  } catch {
    return null;
  }
}

const PermEntry = z.object({ targetKind: z.enum(['model', 'combo', 'alias']), targetId: z.string() });
const IPRule = z.object({ mode: z.enum(['allow', 'deny']), cidr: z.string().min(1).max(64) });

const ApiKeyCreate = z.object({
  name: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
  secret: z.string().min(1).max(256).optional(),
  expiresAt: z.string().nullable().optional(),
  allowAllModels: z.boolean().optional(),
  permissions: z.array(PermEntry).optional(),
  ipRules: z.array(IPRule).optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
  dailyTokenLimit: z.number().int().min(1).nullable().optional(),
  monthlyTokenLimit: z.number().int().min(1).nullable().optional(),
  maxConcurrent: z.number().int().min(1).nullable().optional(),
  maxOutputTokensPerRequest: z.number().int().min(1).nullable().optional(),
  cacheOverrideEnabled: z.boolean().nullable().optional(),
});

const ApiKeyUpdate = ApiKeyCreate.partial().extend({ id: z.string() });

export async function registerApiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminAuth);

  app.get('/api/admin/api-keys', async () => {
    const db = getDb();
    const rows = db.select().from(schema.apiKeys).all();
    const perms = db.select().from(schema.apiKeyModelPermissions).all();
    return {
      apiKeys: rows.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        enabled: k.enabled,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
        allowAllModels: k.allowAllModels,
        modelScopeCount: perms.filter((p) => p.apiKeyId === k.id).length,
        rpmLimit: k.rpmLimit,
        tpmLimit: k.tpmLimit,
        concurrencyLimit: k.maxConcurrent,
        secret: k.keySecretEncrypted && k.keySecretNonce
          ? safeDecrypt({ ciphertext: k.keySecretEncrypted, nonce: k.keySecretNonce, version: k.keySecretVersion ?? 1 })
          : null,
      })),
    };
  });

  app.get('/api/admin/api-keys/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const k = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    if (!k) throw new GatewayError('invalid_request_error', 'API key not found', { status: 404 });
    const perms = db.select().from(schema.apiKeyModelPermissions).where(eq(schema.apiKeyModelPermissions.apiKeyId, id)).all();
    const ipRules = db.select().from(schema.apiKeyIpRules).where(eq(schema.apiKeyIpRules.apiKeyId, id)).all();
    return {
      apiKey: {
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        enabled: k.enabled,
        expiresAt: k.expiresAt,
        allowAllModels: k.allowAllModels,
        permissions: perms,
        ipRules,
        rpmLimit: k.rpmLimit,
        tpmLimit: k.tpmLimit,
        dailyTokenLimit: k.dailyTokenLimit,
        monthlyTokenLimit: k.monthlyTokenLimit,
        maxConcurrent: k.maxConcurrent,
        maxOutputTokensPerRequest: k.maxOutputTokensPerRequest,
        cacheOverrideEnabled: k.cacheOverrideEnabled,
        secret: k.keySecretEncrypted && k.keySecretNonce
          ? safeDecrypt({ ciphertext: k.keySecretEncrypted, nonce: k.keySecretNonce, version: k.keySecretVersion ?? 1 })
          : null,
      },
    };
  });

  app.post('/api/admin/api-keys', async (req) => {
    const body = ApiKeyCreate.parse(req.body);
    const db = getDb();
    // Custom secret if provided, else auto-generate
    const secret = body.secret && body.secret.trim().length > 0
      ? body.secret.trim()
      : generateApiKeySecret();
    const id = uuid();
    const keyPrefix = secret.slice(0, 11);
    const keyDigest = sha256Hex(secret);
    // Reject a duplicate key before inserting: the digest is UNIQUE, and a
    // raw SqliteError (not a GatewayError) would otherwise surface as a
    // generic "Gateway error" 500 to the admin.
    const existing = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyDigest, keyDigest)).get();
    if (existing) {
      throw new GatewayError('invalid_request_error', `An API key with this exact secret already exists ("${existing.name}"). Choose a different key value.`, { status: 409 });
    }
    const enc = encryptSecret(secret);

    // DEBUG: Log what we're about to insert
    console.log(`📝 CREATE API KEY - Name: ${body.name}, Prefix: ${keyPrefix}`);
    console.log(`📝 CREATE API KEY - Secret (full): ${secret}`);
    console.log(`📝 CREATE API KEY - Digest: ${keyDigest}`);

    db.insert(schema.apiKeys).values({
      id,
      name: body.name,
      keyPrefix,
      keyDigest,
      keySecretEncrypted: enc.ciphertext,
      keySecretNonce: enc.nonce,
      keySecretVersion: enc.version,
      enabled: body.enabled ?? true,
      expiresAt: body.expiresAt ?? null,
      allowAllModels: body.allowAllModels ?? false,
      rpmLimit: body.rpmLimit ?? null,
      tpmLimit: body.tpmLimit ?? null,
      dailyTokenLimit: body.dailyTokenLimit ?? null,
      monthlyTokenLimit: body.monthlyTokenLimit ?? null,
      maxConcurrent: body.maxConcurrent ?? null,
      maxOutputTokensPerRequest: body.maxOutputTokensPerRequest ?? null,
      cacheOverrideEnabled: body.cacheOverrideEnabled ?? null,
    }).run();

    // DEBUG: Verify it was actually inserted
    const verify = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    console.log(`✅ INSERT VERIFICATION: ${verify ? 'SUCCESS' : 'FAILED'} - Key exists in DB? ${!!verify}`);
    if (!verify) {
      console.error('❌ DATABASE INSERT FAILED - Key should exist but query returned null');
    }
    if (body.permissions) {
      for (const p of body.permissions) {
        db.insert(schema.apiKeyModelPermissions).values({ id: uuid(), apiKeyId: id, targetKind: p.targetKind, targetId: p.targetId }).run();
      }
    }
    if (body.ipRules) {
      for (const r of body.ipRules) {
        db.insert(schema.apiKeyIpRules).values({ id: uuid(), apiKeyId: id, mode: r.mode, cidr: r.cidr }).run();
      }
    }
    recordAudit({ action: 'api_key.create', success: true, targetType: 'api_key', targetId: id, targetName: body.name, ip: req.ip, metadata: { permissions: body.permissions?.length ?? 0, custom: body.secret ? true : false } });
    return { id, name: body.name, secret, keyPrefix };
  });

  app.patch('/api/admin/api-keys', async (req) => {
    const body = ApiKeyUpdate.parse(req.body);
    const db = getDb();
    const k = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, body.id)).get();
    if (!k) throw new GatewayError('invalid_request_error', 'API key not found', { status: 404 });
    const update: Partial<typeof schema.apiKeys.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.name) update.name = body.name;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.expiresAt !== undefined) update.expiresAt = body.expiresAt;
    if (body.allowAllModels !== undefined) update.allowAllModels = body.allowAllModels;
    if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
    if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
    if (body.dailyTokenLimit !== undefined) update.dailyTokenLimit = body.dailyTokenLimit;
    if (body.monthlyTokenLimit !== undefined) update.monthlyTokenLimit = body.monthlyTokenLimit;
    if (body.maxConcurrent !== undefined) update.maxConcurrent = body.maxConcurrent;
    if (body.maxOutputTokensPerRequest !== undefined) update.maxOutputTokensPerRequest = body.maxOutputTokensPerRequest;
    if (body.cacheOverrideEnabled !== undefined) update.cacheOverrideEnabled = body.cacheOverrideEnabled;
    db.update(schema.apiKeys).set(update).where(eq(schema.apiKeys.id, body.id)).run();
    if (body.permissions) {
      db.delete(schema.apiKeyModelPermissions).where(eq(schema.apiKeyModelPermissions.apiKeyId, body.id)).run();
      for (const p of body.permissions) {
        db.insert(schema.apiKeyModelPermissions).values({ id: uuid(), apiKeyId: body.id, targetKind: p.targetKind, targetId: p.targetId }).run();
      }
    }
    if (body.ipRules) {
      db.delete(schema.apiKeyIpRules).where(eq(schema.apiKeyIpRules.apiKeyId, body.id)).run();
      for (const r of body.ipRules) {
        db.insert(schema.apiKeyIpRules).values({ id: uuid(), apiKeyId: body.id, mode: r.mode, cidr: r.cidr }).run();
      }
    }
    recordAudit({ action: 'api_key.update', success: true, targetType: 'api_key', targetId: body.id, targetName: k.name, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/api-keys/:id/revoke', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const k = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    if (!k) throw new GatewayError('invalid_request_error', 'API key not found', { status: 404 });
    db.update(schema.apiKeys).set({ enabled: false, updatedAt: new Date().toISOString() }).where(eq(schema.apiKeys.id, id)).run();
    recordAudit({ action: 'api_key.revoke', success: true, targetType: 'api_key', targetId: id, targetName: k.name, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/admin/api-keys/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const k = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    if (!k) throw new GatewayError('invalid_request_error', 'API key not found', { status: 404 });
    // Soft-delete: keep name/prefix snapshot for history; mark disabled
    db.update(schema.apiKeys).set({ enabled: false, updatedAt: new Date().toISOString(), name: `${k.name} (deleted ${new Date().toISOString().slice(0, 10)})` }).where(eq(schema.apiKeys.id, id)).run();
    recordAudit({ action: 'api_key.delete', success: true, targetType: 'api_key', targetId: id, targetName: k.name, ip: req.ip });
    return { ok: true };
  });
}
