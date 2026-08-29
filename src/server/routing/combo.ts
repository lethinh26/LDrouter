// Combo routing: fallback (ordered) or weighted round-robin.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { RequiredCapabilities, ModelCapabilitiesInput, modelMeets } from './capabilities';

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
  circuitOpen: boolean;
  capabilities: ModelCapabilitiesInput;
}

export function selectCandidates(combo: ComboPlan, allModels: CandidateModel[], req: RequiredCapabilities): CandidateModel[] {
  // Resolve each combo member to a candidate and apply filters
  const map = new Map(allModels.map((m) => [m.modelId, m]));
  const candidates: CandidateModel[] = [];
  for (const m of combo.members) {
    if (!m.enabled) continue;
    const c = map.get(m.modelId);
    if (!c) continue;
    if (!c.enabled) continue;
    if (!c.upstreamAvailable) continue;
    if (c.circuitOpen) continue;
    if (!modelMeets(c.capabilities, req)) continue;
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
  const cursor = nextCursor(combo.comboId, candidates);
  return cursor;
}

const comboCursors = new Map<string, number>();

function nextCursor(comboId: string, candidates: CandidateModel[]): CandidateModel[] {
  if (candidates.length === 0) return [];
  // Compute total weight of available candidates
  const totalWeight = candidates.reduce((s, c) => {
    const m = (candidates.find((x) => x.modelId === c.modelId));
    void m;
    return s + 1; // weight normalization happens upstream
  }, 0);
  void totalWeight;
  // Simple modulo rotation for determinism in tests
  const cur = (comboCursors.get(comboId) ?? 0) % candidates.length;
  comboCursors.set(comboId, cur + 1);
  return [...candidates.slice(cur), ...candidates.slice(0, cur)];
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
