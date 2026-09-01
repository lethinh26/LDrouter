// Drizzle ORM schema for LateDev Router SQLite database.
// Source of truth: docs/02-DATA-MODEL.md

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ============================================================================
// Application settings (singleton)
// ============================================================================

export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey(),
  setupComplete: integer('setup_complete', { mode: 'boolean' }).notNull().notNull().default(false),
  retentionDays: integer('retention_days').notNull().default(30),
  contentLogMode: text('content_log_mode').notNull().default('metadata'),
  dbSizeLimitMb: integer('db_size_limit_mb').notNull().default(2048),
  trustProxyHops: integer('trust_proxy_hops').notNull().default(0),
  schemaVersion: integer('schema_version').notNull().default(0),
  appVersion: text('app_version').notNull().default('0.0.0'),
  gatewayCacheEnabled: integer('gateway_cache_enabled', { mode: 'boolean' }).notNull().notNull().default(false),
  gatewayCacheDefaultTtlSeconds: integer('gateway_cache_default_ttl_seconds').notNull().default(300),
  gatewayCacheMaxSizeMb: integer('gateway_cache_max_size_mb').notNull().default(256),
  masterKeyVersion: integer('master_key_version').notNull().default(1),
  masterKeyConfigured: integer('master_key_configured', { mode: 'boolean' }).notNull().notNull().default(false),
  // Admin UI notification preferences (v1.8.0). Default true: notifications on, sound on.
  notificationsEnabled: integer('notifications_enabled', { mode: 'boolean' }).notNull().default(true),
  notificationSoundEnabled: integer('notification_sound_enabled', { mode: 'boolean' }).notNull().default(true),
  // Admin site IP access control (v1.11.0): newline-delimited CIDR lists.
  // null = feature disabled.
  adminIpAllow: text('admin_ip_allow'),
  adminIpBlock: text('admin_ip_block'),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// ============================================================================
// Admin account + sessions
// ============================================================================

export const adminAccount = sqliteTable('admin_account', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().notNull().default(false),
  totpSecretEncrypted: text('totp_secret_encrypted'),
  totpSecretNonce: text('totp_secret_nonce'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  lastLoginAt: text('last_login_at'),
});

export const adminRecoveryCodes = sqliteTable(
  'admin_recovery_codes',
  {
    id: text('id').primaryKey(),
    adminId: text('admin_id')
      .notNull()
      .references(() => adminAccount.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    adminIdx: index('idx_recovery_admin').on(t.adminId),
  })
);

export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: text('id').primaryKey(),
    tokenDigest: text('token_digest').notNull().unique(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    expiresIdx: index('idx_session_expires').on(t.expiresAt),
  })
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    ip: text('ip').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    userIdx: index('idx_login_user_time').on(t.username, t.createdAt),
    ipIdx: index('idx_login_ip_time').on(t.ip, t.createdAt),
  })
);

// ============================================================================
// Providers
// ============================================================================

export const providers = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    type: text('type', { enum: ['openai', 'anthropic'] }).notNull(),
    baseUrl: text('base_url').notNull(),
    encryptedApiKey: text('encrypted_api_key').notNull(),
    apiKeyNonce: text('api_key_nonce').notNull(),
    apiKeyVersion: integer('api_key_version').notNull().default(1),
    customHeadersEncrypted: text('custom_headers_encrypted'),
    customHeadersNonce: text('custom_headers_nonce'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().notNull().default(true),
    connectTimeoutMs: integer('connect_timeout_ms').notNull().default(10000),
    firstTokenTimeoutMs: integer('first_token_timeout_ms').notNull().default(30000),
    streamIdleTimeoutMs: integer('stream_idle_timeout_ms').notNull().default(60000),
    totalTimeoutMs: integer('total_timeout_ms').notNull().default(180000),
    maxRetries: integer('max_retries').notNull().default(2),
    retryBaseMs: integer('retry_base_ms').notNull().default(500),
    retryMaxMs: integer('retry_max_ms').notNull().default(8000),
    cbFailureThreshold: integer('cb_failure_threshold').notNull().default(5),
    cbCooldownSeconds: integer('cb_cooldown_seconds').notNull().default(60),
    healthState: text('health_state', { enum: ['healthy', 'degraded', 'down', 'circuit_open', 'unknown'] })
      .notNull()
      .default('unknown'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    slugIdx: uniqueIndex('uniq_provider_slug').on(t.slug),
  })
);

// ============================================================================
// Models
// ============================================================================

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    upstreamModelId: text('upstream_model_id').notNull(),
    publicModelId: text('public_model_id').notNull().unique(),
    displayName: text('display_name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().notNull().default(true),
    upstreamAvailable: integer('upstream_available', { mode: 'boolean' }).notNull().notNull().default(true),
    capabilitiesJson: text('capabilities_json').notNull().default('{}'),
    maxContextTokens: integer('max_context_tokens'),
    maxOutputTokens: integer('max_output_tokens'),
    discoveredMetadataJson: text('discovered_metadata_json'),
    cacheOverrideEnabled: integer('cache_override_enabled', { mode: 'boolean' }),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lastSeenUpstreamAt: text('last_seen_upstream_at'),
  },
  (t) => ({
    publicIdx: uniqueIndex('uniq_model_public').on(t.publicModelId),
    providerUpstreamIdx: uniqueIndex('uniq_provider_upstream').on(t.providerId, t.upstreamModelId),
    enabledIdx: index('idx_model_enabled').on(t.enabled),
  })
);

// ============================================================================
// Combos
// ============================================================================

export const combos = sqliteTable(
  'combos',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    publicModelId: text('public_model_id').notNull().unique(),
    mode: text('mode', { enum: ['fallback', 'weighted_round_robin'] }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().notNull().default(true),
    maxTotalAttempts: integer('max_total_attempts').notNull().default(3),
    fallbackOnConnection: integer('fallback_on_connection', { mode: 'boolean' }).notNull().notNull().default(true),
    fallbackOnConnectTimeout: integer('fallback_on_connect_timeout', { mode: 'boolean' }).notNull().notNull().default(true),
    fallbackOnFirstTokenTimeout: integer('fallback_on_first_token_timeout', { mode: 'boolean' }).notNull().notNull().default(true),
    fallbackOn408: integer('fallback_on_408', { mode: 'boolean' }).notNull().notNull().default(true),
    fallbackOn429: integer('fallback_on_429', { mode: 'boolean' }).notNull().notNull().default(true),
    fallbackOn5xx: integer('fallback_on_5xx', { mode: 'boolean' }).notNull().notNull().default(true),
    cacheOverrideEnabled: integer('cache_override_enabled', { mode: 'boolean' }),
    configVersion: integer('config_version').notNull().default(1),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    slugIdx: uniqueIndex('uniq_combo_slug').on(t.slug),
    publicIdx: uniqueIndex('uniq_combo_public').on(t.publicModelId),
  })
);

export const comboMembers = sqliteTable(
  'combo_members',
  {
    id: text('id').primaryKey(),
    comboId: text('combo_id')
      .notNull()
      .references(() => combos.id, { onDelete: 'cascade' }),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    weight: integer('weight').notNull().default(1),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().notNull().default(true),
  },
  (t) => ({
    uniqMember: uniqueIndex('uniq_combo_model').on(t.comboId, t.modelId),
    posIdx: index('idx_combo_pos').on(t.comboId, t.position),
  })
);

// ============================================================================
// Aliases
// ============================================================================

export const modelAliases = sqliteTable(
  'model_aliases',
  {
    id: text('id').primaryKey(),
    alias: text('alias').notNull().unique(),
    targetKind: text('target_kind', { enum: ['model', 'combo'] }).notNull(),
    targetId: text('target_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().notNull().default(true),
    configVersion: integer('config_version').notNull().default(1),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    aliasIdx: uniqueIndex('uniq_alias').on(t.alias),
  })
);

// ============================================================================
// API keys (gateway keys with ld- prefix)
// ============================================================================

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyDigest: text('key_digest').notNull().unique(),
    keySecretEncrypted: text('key_secret_encrypted'),
    keySecretNonce: text('key_secret_nonce'),
    keySecretVersion: integer('key_secret_version').notNull().default(1),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().notNull().default(true),
    expiresAt: text('expires_at'),
    rpmLimit: integer('rpm_limit'),
    tpmLimit: integer('tpm_limit'),
    dailyTokenLimit: integer('daily_token_limit'),
    monthlyTokenLimit: integer('monthly_token_limit'),
    maxConcurrent: integer('max_concurrent'),
    maxOutputTokensPerRequest: integer('max_output_tokens_per_request'),
    allowAllModels: integer('allow_all_models', { mode: 'boolean' }).notNull().notNull().default(false),
    cacheOverrideEnabled: integer('cache_override_enabled', { mode: 'boolean' }),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lastUsedAt: text('last_used_at'),
  },
  (t) => ({
    digestIdx: uniqueIndex('uniq_key_digest').on(t.keyDigest),
    prefixIdx: index('idx_key_prefix').on(t.keyPrefix),
  })
);

export const apiKeyModelPermissions = sqliteTable(
  'api_key_model_permissions',
  {
    id: text('id').primaryKey(),
    apiKeyId: text('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind', { enum: ['model', 'combo', 'alias'] }).notNull(),
    targetId: text('target_id').notNull(),
  },
  (t) => ({
    uniqPerm: uniqueIndex('uniq_key_target').on(t.apiKeyId, t.targetKind, t.targetId),
  })
);

export const apiKeyIpRules = sqliteTable(
  'api_key_ip_rules',
  {
    id: text('id').primaryKey(),
    apiKeyId: text('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['allow', 'deny'] }).notNull(),
    cidr: text('cidr').notNull(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    keyIdx: index('idx_ip_rule_key').on(t.apiKeyId),
  })
);

// ============================================================================
// Request logs + attempts
// ============================================================================

export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    completedAt: text('completed_at'),
    apiKeyId: text('api_key_id'),
    keyPrefixSnapshot: text('key_prefix_snapshot'),
    clientIp: text('client_ip').notNull(),
    protocol: text('protocol', { enum: ['openai', 'anthropic'] }).notNull(),
    endpoint: text('endpoint').notNull(),
    requestedModel: text('requested_model').notNull(),
    resolvedTargetKind: text('resolved_target_kind', { enum: ['model', 'combo', 'alias', 'unknown'] }).notNull(),
    resolvedTargetId: text('resolved_target_id'),
    finalModelId: text('final_model_id'),
    streaming: integer('streaming', { mode: 'boolean' }).notNull(),
    httpStatus: integer('http_status').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    totalLatencyMs: integer('total_latency_ms').notNull().default(0),
    ttftMs: integer('ttft_ms'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    attemptsCount: integer('attempts_count').notNull().default(0),
    errorType: text('error_type'),
    errorMessage: text('error_message'),
    requestPayloadJson: text('request_payload_json'),
    responsePayloadJson: text('response_payload_json'),
    gatewayCacheHit: integer('gateway_cache_hit', { mode: 'boolean' }).notNull().notNull().default(false),
    partialStream: integer('partial_stream', { mode: 'boolean' }).notNull().notNull().default(false),
  },
  (t) => ({
    createdIdx: index('idx_request_created').on(t.createdAt),
    successIdx: index('idx_request_success').on(t.success, t.createdAt),
    apiKeyIdx: index('idx_request_apikey').on(t.apiKeyId, t.createdAt),
    finalModelIdx: index('idx_request_final_model').on(t.finalModelId, t.createdAt),
    requestedIdx: index('idx_request_requested').on(t.requestedModel, t.createdAt),
    protocolIdx: index('idx_request_protocol').on(t.protocol, t.createdAt),
  })
);

export const requestAttempts = sqliteTable(
  'request_attempts',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    statusCode: integer('status_code'),
    success: integer('success', { mode: 'boolean' }).notNull(),
    latencyMs: integer('latency_ms').notNull().default(0),
    ttftMs: integer('ttft_ms'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    streamStarted: integer('stream_started', { mode: 'boolean' }).notNull().notNull().default(false),
    partialResponse: integer('partial_response', { mode: 'boolean' }).notNull().notNull().default(false),
    selectionReason: text('selection_reason').notNull(),
    failureReason: text('failure_reason'),
    errorMessage: text('error_message'),
    upstreamRequestId: text('upstream_request_id'),
  },
  (t) => ({
    requestIdx: index('idx_attempt_request').on(t.requestId, t.attemptNumber),
    providerModelIdx: index('idx_attempt_provider_model').on(t.providerId, t.modelId, t.startedAt),
  })
);

// ============================================================================
// Audit logs (immutable, excluded from request retention)
// ============================================================================

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    action: text('action').notNull(),
    actor: text('actor').notNull().default('admin'),
    ip: text('ip'),
    success: integer('success', { mode: 'boolean' }).notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetName: text('target_name'),
    metadataJson: text('metadata_json'),
  },
  (t) => ({
    createdIdx: index('idx_audit_created').on(t.createdAt),
    actionIdx: index('idx_audit_action').on(t.action, t.createdAt),
  })
);

// ============================================================================
// Gateway response cache (canonical, exact-key)
// ============================================================================

export const responseCache = sqliteTable(
  'response_cache',
  {
    id: text('id').primaryKey(),
    cacheKey: text('cache_key').notNull().unique(),
    targetKind: text('target_kind', { enum: ['model', 'combo', 'alias'] }).notNull(),
    targetId: text('target_id').notNull(),
    targetConfigVersion: integer('target_config_version').notNull().default(1),
    protocol: text('protocol', { enum: ['openai', 'anthropic'] }).notNull(),
    responseJson: text('response_json').notNull(),
    usageJson: text('usage_json'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    expiresAt: text('expires_at').notNull(),
    lastHitAt: text('last_hit_at'),
    hitCount: integer('hit_count').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
  },
  (t) => ({
    expiresIdx: index('idx_cache_expires').on(t.expiresAt),
    targetIdx: index('idx_cache_target').on(t.targetKind, t.targetId),
  })
);

// ============================================================================
// Daily usage aggregates (for daily/monthly quota + statistics fast path)
// ============================================================================

export const usageDaily = sqliteTable(
  'usage_daily',
  {
    day: text('day').notNull(), // YYYY-MM-DD
    apiKeyId: text('api_key_id').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
  },
  (t) => ({
    pk: uniqueIndex('uniq_usage_day_key').on(t.day, t.apiKeyId),
  })
);

export const usageMonthly = sqliteTable(
  'usage_monthly',
  {
    month: text('month').notNull(), // YYYY-MM
    apiKeyId: text('api_key_id').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
  },
  (t) => ({
    pk: uniqueIndex('uniq_usage_month_key').on(t.month, t.apiKeyId),
  })
);

// ============================================================================
// Backups
// ============================================================================

export const backups = sqliteTable('backups', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  schemaVersion: integer('schema_version').notNull(),
  appVersion: text('app_version').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  checksum: text('checksum').notNull(),
  path: text('path').notNull(),
  notes: text('notes'),
});

// ============================================================================
// CSRF tokens (stateful per-session CSRF reference)
// ============================================================================

export const csrfTokens = sqliteTable(
  'csrf_tokens',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    token: text('token').notNull(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    sessionIdx: index('idx_csrf_session').on(t.sessionId),
    expiresIdx: index('idx_csrf_expires').on(t.expiresAt),
  })
);

// ============================================================================
// Schema version tracking (for backup compatibility checks)
// ============================================================================

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// Convenience type re-exports
export type Provider = typeof providers.$inferSelect;
export type Model = typeof models.$inferSelect;
export type Combo = typeof combos.$inferSelect;
export type ComboMember = typeof comboMembers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Request = typeof requests.$inferSelect;
export type Attempt = typeof requestAttempts.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type AppSettingsRow = typeof appSettings.$inferSelect;
export type ResponseCacheRow = typeof responseCache.$inferSelect;
