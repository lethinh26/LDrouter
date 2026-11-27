// Combo routing: ordered fallback.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { RequiredCapabilities, ModelCapabilitiesInput, firstMissingCapability, type RejectionReason } from './capabilities';

export interface ComboMember {
  id: string;
  modelId: string;
  position: number;
  enabled: boolean;
}

export interface ComboPlan {
  comboId: string;
  comboKind?: 'standard' | 'codex_native';
  configVersion?: number;
  mode: 'fallback';
  maxTotalAttempts: number;
  slowResponseFallbackEnabled?: boolean;
  slowResponseThresholdMs?: number;
  slowResponseMaxCount?: number;
  slowResponseGeneration?: number;
  maxRequestDurationSeconds?: number | null;
  enabled?: boolean;
  members: ComboMember[];
  trigger: {
    connection: boolean;
    connectTimeout: boolean;
    firstTokenTimeout: boolean;
    totalTimeout: boolean;
    on408: boolean;
    on429: boolean;
    on5xx: boolean;
  };
}

export function loadCombo(comboId: string): ComboPlan | null {
  const db = getDb();
  const c = db.select().from(schema.combos).where(eq(schema.combos.id, comboId)).get();
  if (!c) return null;
  const members = db.select().from(schema.comboMembers).where(eq(schema.comboMembers.comboId, comboId)).all();
  return {
    comboId: c.id,
    comboKind: c.comboKind,
    configVersion: c.configVersion,
    mode: 'fallback',
    maxTotalAttempts: c.maxTotalAttempts,
    slowResponseFallbackEnabled: c.comboKind !== 'codex_native' && c.slowResponseFallbackEnabled,
    slowResponseThresholdMs: c.slowResponseThresholdSeconds * 1000,
    slowResponseMaxCount: c.slowResponseMaxCount,
    slowResponseGeneration: c.slowResponseGeneration,
    maxRequestDurationSeconds: c.maxRequestDurationSeconds,
    enabled: c.enabled,
    members: members.map((m) => ({ id: m.id, modelId: m.modelId, position: m.position, enabled: m.enabled })),
    trigger: {
      connection: c.fallbackOnConnection,
      connectTimeout: c.fallbackOnConnectTimeout,
      firstTokenTimeout: c.fallbackOnFirstTokenTimeout,
      totalTimeout: c.fallbackOnTotalTimeout,
      on408: c.fallbackOn408,
      on429: c.comboKind !== 'codex_native' && c.fallbackOn429,
      on5xx: c.fallbackOn5xx,
    },
  };
}

export interface CandidateModel {
  modelId: string;
  /** The combo_members row captured when this request loaded its routing plan. */
  comboMemberId?: string;
  publicModelId: string;
  upstreamModelId: string;
  providerId: string;
  enabled: boolean;
  upstreamAvailable: boolean;
  /** Cooldown-aware: false once the breaker's cooldown has elapsed, so the half-open probe can run. */
  circuitOpen: boolean;
  /** undefined = unknown (treated as usable); only an explicit false rejects. */
  providerEnabled?: boolean;
  capabilities: ModelCapabilitiesInput;
}

export function selectCandidates(
  combo: ComboPlan,
  allModels: CandidateModel[],
  req: RequiredCapabilities,
  onReject?: (candidate: { modelId: string; publicModelId: string }, reason: RejectionReason) => void
): CandidateModel[] {
  // Resolve each combo member to a candidate and apply filters
  const map = new Map(allModels.map((m) => [m.modelId, m]));
  const candidates: CandidateModel[] = [];
  for (const m of combo.members) {
    if (!m.enabled) { onReject?.({ modelId: m.modelId, publicModelId: map.get(m.modelId)?.publicModelId ?? m.modelId }, 'member_disabled'); continue; }
    const c = map.get(m.modelId);
    if (!c) { onReject?.({ modelId: m.modelId, publicModelId: m.modelId }, 'model_not_found'); continue; }
    if (c.providerEnabled === false) { onReject?.(c, 'provider_disabled'); continue; }
    if (!c.enabled) { onReject?.(c, 'model_disabled'); continue; }
    if (!c.upstreamAvailable) { onReject?.(c, 'upstream_unavailable'); continue; }
    if (c.circuitOpen) { onReject?.(c, 'circuit_open'); continue; }
    const missing = firstMissingCapability(c.capabilities, req);
    if (missing) { onReject?.(c, missing); continue; }
    candidates.push({ ...c, comboMemberId: m.id });
  }
  return candidates;
}

export function orderCandidates(combo: ComboPlan, candidates: CandidateModel[]): CandidateModel[] {
  // Preserve declared position order.
  return [...candidates].sort((a, b) => {
    const am = combo.members.find((m) => m.modelId === a.modelId);
    const bm = combo.members.find((m) => m.modelId === b.modelId);
    return (am?.position ?? 0) - (bm?.position ?? 0) || (am?.id ?? a.modelId).localeCompare(bm?.id ?? b.modelId);
  });
}

export function shouldFallback(combo: ComboPlan, reason: { type: string; status?: number }): boolean {
  switch (reason.type) {
    case 'connection_error':
      return combo.trigger.connection;
    case 'connect_timeout':
      return combo.trigger.connectTimeout;
    case 'first_token_timeout':
      return combo.trigger.firstTokenTimeout;
    case 'total_timeout':
      return combo.trigger.totalTimeout;
    case 'quota':
      // Preserve quota exhaustion fallback independently of transient HTTP 429/5xx triggers.
      return true;
    case 'http_status':
      if (reason.status === 408) return combo.trigger.on408;
      if (reason.status === 429) return combo.trigger.on429;
      if (reason.status && reason.status >= 500 && reason.status < 600) return combo.trigger.on5xx;
      return false;
    case 'stream_partial':
      // Per spec: never fallback after stream content has been sent.
      return false;
    default:
      return false;
  }
}
