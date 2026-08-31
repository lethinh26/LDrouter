// Shared public types between server and web admin UI.

export type Protocol = 'openai' | 'anthropic';

export type CapabilityKey =
  | 'chat'
  | 'responses'
  | 'streaming'
  | 'tools'
  | 'structured_output'
  | 'image_input'
  | 'audio_input'
  | 'reasoning'
  | 'embeddings';

export interface ModelCapabilities {
  chat?: boolean;
  responses?: boolean;
  streaming?: boolean;
  tools?: boolean;
  structured_output?: boolean;
  image_input?: boolean;
  audio_input?: boolean;
  reasoning?: boolean;
  embeddings?: boolean;
  max_context_tokens?: number | null;
  max_output_tokens?: number | null;
  [k: string]: boolean | number | null | undefined;
}

export type ComboMode = 'fallback' | 'weighted_round_robin';

export type ContentLogMode = 'off' | 'metadata' | 'prompt' | 'prompt_and_response';

export type RetentionMode = 'forever' | `${number}d` | 'custom';

export interface AppSettings {
  setupComplete: boolean;
  retentionDays: number;
  retentionMode: RetentionMode;
  customRetentionDays: number | null;
  contentLogMode: ContentLogMode;
  dbSizeLimitMb: number;
  trustProxyHops: number;
  schemaVersion: number;
  appVersion: string;
  gatewayCacheEnabled: boolean;
  gatewayCacheDefaultTtlSeconds: number;
  gatewayCacheMaxSizeMb: number;
  masterKeyConfigured: boolean;
  masterKeyVersion: number;
  // v1.8.0 — admin UI notification preferences
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
}

export interface AdminSessionInfo {
  id: string;
  username: string;
  expiresAt: string;
  totpEnabled: boolean;
}

export interface ProviderSummary {
  id: string;
  name: string;
  slug: string;
  type: Protocol;
  baseUrl: string;
  enabled: boolean;
  health: 'healthy' | 'degraded' | 'down' | 'circuit_open' | 'unknown';
  modelCount: number;
  recentErrorRate: number | null;
  recentAvgLatencyMs: number | null;
}

export interface ModelSummary {
  id: string;
  providerId: string;
  providerSlug: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled: boolean;
  upstreamAvailable: boolean;
  capabilities: ModelCapabilities;
  lastSeenUpstreamAt: string | null;
}

export interface ComboSummary {
  id: string;
  name: string;
  slug: string;
  publicModelId: string;
  mode: ComboMode;
  enabled: boolean;
  memberCount: number;
  healthyMemberCount: number;
}

export interface ComboMemberSpec {
  modelId: string;
  position: number;
  weight: number;
  enabled: boolean;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  allowAllModels: boolean;
  modelScopeCount: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  concurrencyLimit: number | null;
}

export interface RequestLogSummary {
  id: string;
  createdAt: string;
  completedAt: string | null;
  apiKeyName: string | null;
  keyPrefix: string | null;
  clientIp: string;
  protocol: Protocol;
  endpoint: string;
  requestedModel: string;
  resolvedTargetKind: 'model' | 'combo' | 'alias' | 'unknown';
  finalModelPublicId: string | null;
  // Added v1.9.0: provider id/name derived from finalModelId (for routing aggregation).
  providerId: string | null;
  providerName: string | null;
  streaming: boolean;
  httpStatus: number;
  success: boolean;
  totalLatencyMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  attemptsCount: number;
  errorType: string | null;
  errorMessage: string | null;
  gatewayCacheHit: boolean;
}

export interface AttemptLog {
  id: string;
  attemptNumber: number;
  providerId: string;
  providerName: string;
  modelId: string;
  modelPublicId: string;
  startedAt: string;
  completedAt: string | null;
  statusCode: number | null;
  success: boolean;
  latencyMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  streamStarted: boolean;
  partialResponse: boolean;
  selectionReason: string;
  failureReason: string | null;
  sanitizedError: string | null;
  upstreamRequestId: string | null;
}

export interface StatsRange {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
}

export interface StatsSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  averageTtftMs: number | null;
  p95TtftMs: number | null;
  cacheHitRate: number;
  gatewayCacheHitRate: number;
  fallbackRate: number;
}

/** Per-provider traffic/latency/health summary for the routing-flow dashboard (v1.9.0). */
export interface RoutingProvider {
  id: string;
  name: string;
  slug: string;
  health: 'healthy' | 'degraded' | 'down' | 'circuit_open' | 'unknown';
  enabled: boolean;
  modelCount: number;
  requests: number;
  errorRate: number;
  avgLatencyMs: number;
}

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  action: string;
  actor: string;
  ip: string;
  success: boolean;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  metadata: Record<string, unknown>;
}

export interface GatewayErrorBody {
  error: {
    type: string;
    message: string;
    code?: string;
    request_id?: string;
  };
}
