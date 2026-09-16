// Combo routing: fallback (ordered) or weighted round-robin.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { RequiredCapabilities, ModelCapabilitiesInput, firstMissingCapability, type RejectionReason } from './capabilities';

export interface ComboMember {
  id: string;
  modelId: string;
  position: number;
  weight: number;
  enabled: boolean;
}

export interface ComboPlan {
  comboId: string;
  mode: 'fallback' | 'weighted_round_robin';
  maxTotalAttempts: number;
  members: ComboMember[];
  trigger: {
    connection: boolean;
    connectTimeout: boolean;
    firstTokenTimeout: boolean;
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
    mode: c.mode,
    maxTotalAttempts: c.maxTotalAttempts,
    members: members.map((m) => ({ id: m.id, modelId: m.modelId, position: m.position, weight: m.weight, enabled: m.enabled })),
    trigger: {
      connection: c.fallbackOnConnection,
      connectTimeout: c.fallbackOnConnectTimeout,
      firstTokenTimeout: c.fallbackOnFirstTokenTimeout,
      on408: c.fallbackOn408,
      on429: c.fallbackOn429,
      on5xx: c.fallbackOn5xx,
    },
  };
}

export interface CandidateModel {
  modelId: string;
  publicModelId: string;
  providerId: string;
  enabled: boolean;
  upstreamAvailable: boolean;
  /** undefined = unknown (treated as usable); only an explicit false rejects. */
  providerEnabled?: boolean;
  circuitOpen: boolean;
  capabilities: ModelCapabilitiesInput;
  codexAccountId?: string;
  codexChatgptAccountId?: string;
  qoderAccountId?: string;
  qoderUserId?: string;
  providerType?: string;
  selectionReason?: string;
}

export interface CodexAccountCandidate {
  id: string;
  chatgptAccountId: string;
  enabled: boolean;
  healthState: 'healthy' | 'degraded' | 'down' | 'unknown';
  tokenExpiresAt: string;
  priority: number;
}

export interface QoderAccountCandidate {
  id: string;
  qoderUserId: string;
  enabled: boolean;
  healthState: string;
  priority: number;
}

/**
 * One Qoder candidate per eligible account so account-level fallback works without touching the
 * combo plan. Keyed off the resolved provider type, never a hardcoded slug prefix.
 *
 * A `degraded` account stays eligible: it is a warning (last migration of a billing/quota block),
 * not a verdict — the runner retries it and the upstream answers honestly. Only `down` and
 * `disabled` are excluded.
 */
export function expandQoderAccountCandidates(candidate: CandidateModel, accounts: QoderAccountCandidate[]): CandidateModel[] {
  if (candidate.providerType !== 'qoder') return [candidate];
  const usable = accounts
    .filter((account) => account.enabled && account.healthState !== 'down')
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return usable.map((account) => ({ ...candidate, qoderAccountId: account.id, qoderUserId: account.qoderUserId, selectionReason: 'qoder_account' }));
}

export function expandCodexAccountCandidates(candidate: CandidateModel, accounts: CodexAccountCandidate[]): CandidateModel[] {
  if (candidate.providerType !== 'codex') return [candidate];
  // No token-expiry filter here: `withCodexCredentials` refreshes before the upstream call, so an
  // expired token is still routable. Gating on it rejected exactly the accounts most in need of a
  // refresh, turning a recoverable state into "no available Codex account".
  const usable = accounts.filter((a) => a.enabled && a.healthState !== 'down')
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return usable.map((a) => ({ ...candidate, codexAccountId: a.id, codexChatgptAccountId: a.chatgptAccountId, selectionReason: 'codex_account' }));
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
    candidates.push(c);
  }
  return candidates;
}

export function orderCandidates(combo: ComboPlan, candidates: CandidateModel[]): CandidateModel[] {
  if (combo.mode === 'fallback') {
    // Preserve declared position order
    return [...candidates].sort((a, b) => {
      const am = combo.members.find((m) => m.modelId === a.modelId);
      const bm = combo.members.find((m) => m.modelId === b.modelId);
      return (am?.position ?? 0) - (bm?.position ?? 0);
    });
  }
  // Weighted round-robin: stable order with weighted lead bias.
  // We rotate via a process-local cursor keyed by combo id.
  const cursor = nextCursor(combo.comboId, combo.members, candidates);
  return cursor;
}

const comboCursors = new Map<string, number>();

function nextCursor(comboId: string, members: ComboMember[], candidates: CandidateModel[]): CandidateModel[] {
  if (candidates.length === 0) return [];
  // Repeat each available member according to its configured positive weight,
  // then advance one slot per request. This is deterministic weighted RR.
  const slots = members.flatMap((member) => {
    const candidate = candidates.find((c) => c.modelId === member.modelId);
    if (!candidate) return [];
    return Array.from({ length: Math.max(1, member.weight) }, () => candidate);
  });
  const cur = (comboCursors.get(comboId) ?? 0) % Math.max(1, slots.length);
  comboCursors.set(comboId, cur + 1);
  const selected = slots[cur] ?? candidates[0]!;
  return [selected, ...candidates.filter((candidate) => candidate !== selected)];
}

export function shouldFallback(combo: ComboPlan, reason: { type: string; status?: number }): boolean {
  switch (reason.type) {
    case 'connection_error':
      return combo.trigger.connection;
    case 'connect_timeout':
      return combo.trigger.connectTimeout;
    case 'first_token_timeout':
      return combo.trigger.firstTokenTimeout;
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
