import { and, eq } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../db';

export const COMBO_SLOW_FALLBACK_COOLDOWN_MS = 5 * 60 * 1000;
export const COMBO_SLOW_FALLBACK_PROBE_LEASE_MS = 90 * 1000;

export interface ComboSlowState {
  comboId: string;
  modelId: string;
  consecutiveSlowCount: number;
  cooldownUntilMs: number | null;
  probeLeaseUntilMs: number | null;
  lastLatencyMs: number | null;
  lastOutcome: 'slow' | 'fast' | 'error' | 'unknown';
  updatedAtMs: number;
}

type ComboSlowStateRow = typeof schema.comboMemberSlowStates.$inferSelect;

function toState(row: ComboSlowStateRow): ComboSlowState {
  return {
    comboId: row.comboId,
    modelId: row.modelId,
    consecutiveSlowCount: row.consecutiveSlowCount,
    cooldownUntilMs: row.cooldownUntilMs,
    probeLeaseUntilMs: row.probeLeaseUntilMs,
    lastLatencyMs: row.lastLatencyMs,
    lastOutcome: row.lastOutcome,
    updatedAtMs: row.updatedAtMs,
  };
}

export function listComboSlowStates(comboId: string): ComboSlowState[] {
  return getDb().select().from(schema.comboMemberSlowStates)
    .where(eq(schema.comboMemberSlowStates.comboId, comboId))
    .all()
    .map(toState);
}

export function getComboSlowState(comboId: string, modelId: string): ComboSlowState | null {
  const row = getDb().select().from(schema.comboMemberSlowStates)
    .where(and(
      eq(schema.comboMemberSlowStates.comboId, comboId),
      eq(schema.comboMemberSlowStates.modelId, modelId),
    ))
    .get();
  return row ? toState(row) : null;
}

/** Atomically grants one post-cooldown probe across concurrent gateway requests. */
export function claimComboSlowProbe(
  comboId: string,
  modelId: string,
  memberId: string,
  now = Date.now(),
  leaseMs = COMBO_SLOW_FALLBACK_PROBE_LEASE_MS,
  expectedGeneration?: number,
): boolean {
  const result = getRawDb().prepare(`
    UPDATE combo_member_slow_states
    SET probe_lease_until_ms = ?, updated_at_ms = ?
    WHERE combo_id = ? AND model_id = ?
      AND cooldown_until_ms IS NOT NULL AND cooldown_until_ms <= ?
      AND (probe_lease_until_ms IS NULL OR probe_lease_until_ms <= ?)
      AND EXISTS (
        SELECT 1 FROM combos c
        JOIN combo_members m ON m.combo_id = c.id
        WHERE c.id = ? AND m.model_id = ? AND m.id = ?
          AND (? IS NULL OR c.slow_response_generation = ?)
      )
  `).run(now + leaseMs, now, comboId, modelId, now, now, comboId, modelId, memberId, expectedGeneration ?? null, expectedGeneration ?? null);
  return result.changes === 1;
}

/**
 * A slow outcome increments the consecutive count and starts cooldown at the configured limit.
 * A fast response clears the history and any probe lease.
 */
export function recordComboSlowOutcome(
  comboId: string,
  modelId: string,
  memberId: string,
  outcome: 'slow' | 'fast',
  maxSlowCount: number,
  latencyMs: number | null,
  now = Date.now(),
  expectedGeneration?: number,
): void {
  const raw = getRawDb();
  const update = raw.transaction(() => {
    const member = raw.prepare(`
      SELECT c.slow_response_generation
      FROM combos c
      JOIN combo_members m ON m.combo_id = c.id
      WHERE c.id = ? AND m.model_id = ? AND m.id = ?
    `).get(comboId, modelId, memberId) as { slow_response_generation: number } | undefined;
    if (!member || (expectedGeneration !== undefined && member.slow_response_generation !== expectedGeneration)) return;
    const current = raw.prepare(`
      SELECT consecutive_slow_count
      FROM combo_member_slow_states
      WHERE combo_id = ? AND model_id = ?
    `).get(comboId, modelId) as { consecutive_slow_count: number } | undefined;
    if (!current && outcome === 'fast') return;

    const consecutiveSlowCount = outcome === 'slow'
      ? Math.min((current?.consecutive_slow_count ?? 0) + 1, maxSlowCount)
      : 0;
    const cooldownUntilMs = outcome === 'slow' && consecutiveSlowCount >= maxSlowCount
      ? now + COMBO_SLOW_FALLBACK_COOLDOWN_MS
      : null;
    raw.prepare(`
      INSERT INTO combo_member_slow_states (
        combo_id, model_id, consecutive_slow_count, cooldown_until_ms,
        probe_lease_until_ms, last_latency_ms, last_outcome, updated_at_ms
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(combo_id, model_id) DO UPDATE SET
        consecutive_slow_count = excluded.consecutive_slow_count,
        cooldown_until_ms = excluded.cooldown_until_ms,
        probe_lease_until_ms = NULL,
        last_latency_ms = excluded.last_latency_ms,
        last_outcome = excluded.last_outcome,
        updated_at_ms = excluded.updated_at_ms
    `).run(comboId, modelId, consecutiveSlowCount, cooldownUntilMs, latencyMs, outcome, now);
  });
  update();
}

/** A failed probe re-enters cooldown; ordinary failed attempts do not alter slow history. */
export function releaseComboSlowProbe(
  comboId: string,
  modelId: string,
  memberId: string,
  rearmCooldown: boolean,
  now = Date.now(),
  expectedGeneration?: number,
): void {
  getRawDb().prepare(`
    UPDATE combo_member_slow_states
    SET probe_lease_until_ms = NULL,
        cooldown_until_ms = CASE WHEN ? = 1 THEN ? ELSE cooldown_until_ms END,
        last_outcome = CASE WHEN ? = 1 THEN 'error' ELSE last_outcome END,
        updated_at_ms = ?
    WHERE combo_id = ? AND model_id = ? AND probe_lease_until_ms IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM combos c
        JOIN combo_members m ON m.combo_id = c.id
        WHERE c.id = ? AND m.model_id = ? AND m.id = ?
          AND (? IS NULL OR c.slow_response_generation = ?)
      )
  `).run(
    rearmCooldown ? 1 : 0,
    rearmCooldown ? now + COMBO_SLOW_FALLBACK_COOLDOWN_MS : null,
    rearmCooldown ? 1 : 0,
    now,
    comboId,
    modelId,
    comboId,
    modelId,
    memberId,
    expectedGeneration ?? null,
    expectedGeneration ?? null,
  );
}
