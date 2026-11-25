// Persistent, bounded adaptive evidence and owned probe leases. No transaction
// spans an upstream call; outcomes are fenced against member/config/DB changes.
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDatabaseEpoch, getDb, getRawDb, schema } from '../db';
import type { CandidateModel, ComboPlan } from './combo';
import {
  type AdaptiveState, type AdaptiveSample, type AdaptiveOutcomeKind, type AdaptiveRole,
  SAMPLE_TTL_MS, SAMPLE_LIMIT, MIN_COMPARABLE_SAMPLES, RELATIVE_SLOW_COUNT,
  INITIAL_PROBE_DELAY_MS, CONFIRM_PROBE_DELAY_MS, EXPLORATION_INTERVAL_MS,
  WORKLOADS, freshSamples, median, reliableMedian, similarityMargin, demotionMargin, probeDelayMs,
} from './combo-policy';

export type { AdaptiveState, AdaptiveRole, AdaptiveOutcomeKind } from './combo-policy';

type Row = typeof schema.comboAdaptiveStates.$inferSelect;
export interface AdaptiveAttemptFence { epoch: string; sequence: number }
let sequence = 0;

/** Call immediately before actual dispatch, not when a candidate is selected. */
export function beginAdaptiveAttempt(): AdaptiveAttemptFence {
  return { epoch: getDatabaseEpoch(), sequence: ++sequence };
}

function parseSamples(raw: string): AdaptiveSample[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((sample): sample is AdaptiveSample => sample !== null && typeof sample === 'object' &&
      Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0 && Number.isFinite(sample.atMs)).slice(-SAMPLE_LIMIT);
  } catch { return []; }
}

function fromRow(row: Row, explorationDueMs: number | null): AdaptiveState {
  const {samplesJson, ...rest} = row;
  return { ...rest, samples: parseSamples(samplesJson), explorationDueMs };
}

function generationOf(plan: ComboPlan): number { return plan.slowResponseGeneration ?? 1; }
function memberOf(plan: ComboPlan, candidate: CandidateModel): string | undefined {
  return plan.members.find(m => m.modelId === candidate.modelId && m.enabled &&
    (!candidate.comboMemberId || m.id === candidate.comboMemberId))?.id;
}

function isCurrentMember(plan: ComboPlan, candidate: CandidateModel, memberId: string): boolean {
  return Boolean(getRawDb().prepare(`
    SELECT 1 FROM combos c
    JOIN combo_members cm ON cm.combo_id=c.id
    JOIN models m ON m.id=cm.model_id
    JOIN providers p ON p.id=m.provider_id
    WHERE c.id=? AND c.slow_response_generation=? AND c.enabled=1 AND c.slow_response_fallback_enabled=1
      AND cm.id=? AND cm.model_id=? AND cm.enabled=1 AND m.enabled=1 AND m.upstream_available=1
      AND p.enabled=1 AND p.id=?
  `).get(plan.comboId,generationOf(plan),memberId,candidate.modelId,candidate.providerId));
}

export function listAdaptiveStates(comboId: string, workload?: string): AdaptiveState[] {
  if (workload !== undefined && !WORKLOADS.has(workload)) return [];
  const db = getDb();
  const combo = db.select({generation:schema.combos.slowResponseGeneration}).from(schema.combos)
    .where(eq(schema.combos.id,comboId)).get();
  if (!combo) return [];
  const {generation} = combo;
  const states = db.select().from(schema.comboAdaptiveStates).where(and(
    eq(schema.comboAdaptiveStates.comboId,comboId),eq(schema.comboAdaptiveStates.generation,generation),
    workload === undefined ? undefined : eq(schema.comboAdaptiveStates.workload,workload),
  )).all();
  const exploration = new Map(db.select().from(schema.comboAdaptiveExploration).where(and(
    eq(schema.comboAdaptiveExploration.comboId,comboId),eq(schema.comboAdaptiveExploration.generation,generation),
  )).all().map(row => [row.workload,row.nextDueMs]));
  return states.map(row => fromRow(row,exploration.get(row.workload) ?? null));
}

/** Compare-and-set ownership per member/workload/generation, including lease expiry. */
export function claimAdaptiveProbe(plan: ComboPlan, candidate: CandidateModel, workload: string, now: number, leaseMs: number): string | null {
  const memberId = memberOf(plan,candidate);
  if (!memberId || !plan.slowResponseFallbackEnabled || !WORKLOADS.has(workload) || !Number.isFinite(leaseMs) || leaseMs <= 0) return null;
  const raw = getRawDb();
  return raw.transaction(() => {
    if (!isCurrentMember(plan,candidate,memberId)) return null;
    const token = crypto.randomUUID();
    const result = raw.prepare(`
      UPDATE combo_adaptive_states
      SET probe_token=?, probe_lease_until_ms=?
      WHERE combo_id=? AND member_id=? AND model_id=? AND workload=? AND generation=?
        AND degraded IS NOT NULL AND probe_due_ms<=?
        AND COALESCE(last_observation_ms,updated_at_ms)>=?
        AND (probe_lease_until_ms IS NULL OR probe_lease_until_ms<=?)
    `).run(token,now+leaseMs,plan.comboId,memberId,candidate.modelId,workload,generationOf(plan),now,now-SAMPLE_TTL_MS,now);
    return result.changes === 1 ? token : null;
  }).immediate();
}

/** Release only the original owner, e.g. if circuit claim failed before dispatch. */
export function releaseAdaptiveProbe(plan: ComboPlan, candidate: CandidateModel, workload: string, token: string): void {
  const memberId = memberOf(plan,candidate);
  if (!memberId || !token) return;
  getRawDb().prepare(`
    UPDATE combo_adaptive_states SET probe_token=NULL, probe_lease_until_ms=NULL
    WHERE combo_id=? AND member_id=? AND workload=? AND generation=? AND probe_token=?
  `).run(plan.comboId,memberId,workload,generationOf(plan),token);
}

export function claimAdaptiveExploration(plan: ComboPlan, workload: string, now: number): boolean {
  if (!plan.slowResponseFallbackEnabled || !WORKLOADS.has(workload)) return false;
  const raw = getRawDb();
  const result = raw.prepare(`
    INSERT INTO combo_adaptive_exploration (combo_id,workload,generation,next_due_ms)
    SELECT id,?,slow_response_generation,? FROM combos
    WHERE id=? AND enabled=1 AND slow_response_fallback_enabled=1 AND slow_response_generation=?
    ON CONFLICT(combo_id,workload) DO UPDATE SET generation=excluded.generation,next_due_ms=excluded.next_due_ms
    WHERE combo_adaptive_exploration.generation<>excluded.generation OR combo_adaptive_exploration.next_due_ms<=?
  `).run(workload,now+EXPLORATION_INTERVAL_MS,plan.comboId,generationOf(plan),now);
  return result.changes === 1;
}

export interface RecordAdaptiveOutcomeInput {
  plan: ComboPlan;
  candidate: CandidateModel;
  workload: string;
  startedAtMs: number;
  now: number;
  kind: AdaptiveOutcomeKind;
  latencyMs: number | null;
  role: AdaptiveRole;
  probeToken?: string | null;
  comparableCandidates: CandidateModel[];
  learn: boolean;
  /** Required by runtime; optional for synchronous deterministic fixture calls. */
  attemptFence?: AdaptiveAttemptFence;
  /** Injected only for deterministic tests; production gets bounded random jitter. */
  jitter?: number;
}

function initialState(plan: ComboPlan,candidate: CandidateModel,memberId: string,workload: string,now: number): AdaptiveState {
  return {
    comboId:plan.comboId,memberId,modelId:candidate.modelId,workload,generation:generationOf(plan),samples:[],
    consecutiveSlowCount:0,relativeSlowCount:0,degraded:null,comparatorModelId:null,probeDueMs:null,
    probeLeaseUntilMs:null,probeToken:null,recoverySuccesses:0,probeFailures:0,lastLatencyMs:null,
    lastOutcome:'unknown',updatedAtMs:now,lastObservationMs:null,lastStartMs:null,lastStartSequence:0,
    baselineLatencyMs:null,suspectCount:0,explorationDueMs:null,
  };
}

function persistState(state: AdaptiveState): void {
  const {samples,explorationDueMs: _explorationDueMs,...rest} = state;
  const values = {...rest,samplesJson:JSON.stringify(samples.slice(-SAMPLE_LIMIT))};
  getDb().insert(schema.comboAdaptiveStates).values(values).onConflictDoUpdate({
    target:[schema.comboAdaptiveStates.memberId,schema.comboAdaptiveStates.workload],
    set:values,
  }).run();
}

export function recordAdaptiveOutcome(input: RecordAdaptiveOutcomeInput): void {
  const {plan,candidate,workload,startedAtMs,now,kind,role,probeToken} = input;
  const memberId = memberOf(plan,candidate);
  if (!memberId || !WORKLOADS.has(workload) || !plan.slowResponseFallbackEnabled) return;
  // An older async request cannot write to a newly opened database even when
  // combo/member IDs and persisted generation happen to match after restore.
  if (input.attemptFence && input.attemptFence.epoch !== getDatabaseEpoch()) return;
  const seq = input.attemptFence?.sequence ?? ++sequence;
  const raw = getRawDb();
  raw.transaction(() => {
    if (!isCurrentMember(plan,candidate,memberId)) return;
    const current = listAdaptiveStates(plan.comboId,workload);
    const old = current.find(s => s.memberId === memberId);
    const probe = role === 'probe';
    if (probe) {
      if (!probeToken || old?.probeToken !== probeToken) return;
      if (old.probeLeaseUntilMs === null || old.probeLeaseUntilMs <= now) {
        releaseAdaptiveProbe(plan,candidate,workload,probeToken);
        return;
      }
    }
    // Non-learning admin tests, and cancellation before learning, must never
    // mutate counters or promote recovery. They may release their owned lease.
    if (!input.learn || kind === 'cancel') {
      if (probe && probeToken) releaseAdaptiveProbe(plan,candidate,workload,probeToken);
      return;
    }
    if (old?.lastStartMs != null) {
      const stale = input.attemptFence
        ? old.lastStartSequence >= seq
        : old.lastStartMs > startedAtMs || (old.lastStartMs === startedAtMs && old.lastStartSequence >= seq);
      if (stale) {
        if (probe && probeToken) releaseAdaptiveProbe(plan,candidate,workload,probeToken);
        return;
      }
    }
    // A reserve can still serve traffic while a probe is active. Do not let
    // its ordinary outcome overwrite the probe's owner or recovery decision.
    if (!probe && old?.probeToken && (old.probeLeaseUntilMs ?? 0) > now) return;

    const state = old ?? initialState(plan,candidate,memberId,workload,now);
    if (!probe && state.lastObservationMs !== null && (state.lastObservationMs < now-SAMPLE_TTL_MS || state.lastObservationMs > now)) {
      Object.assign(state, initialState(plan,candidate,memberId,workload,now));
    }
    state.samples = freshSamples(state.samples,now);
    const threshold = plan.slowResponseThresholdMs ?? 60_000;
    const maxCount = plan.slowResponseMaxCount ?? 3;
    const validLatency = input.latencyMs !== null && Number.isFinite(input.latencyMs) && input.latencyMs >= 0;
    const success = kind === 'success' && validLatency;
    const observed = success || kind === 'soft_timeout';
    const latency = success ? Math.round(input.latencyMs!) : kind === 'soft_timeout' ? Math.max(threshold,validLatency ? Math.round(input.latencyMs!) : threshold) : null;
    const comparator = input.comparableCandidates
      .filter(c => c.modelId !== candidate.modelId && c.enabled && c.upstreamAvailable && !c.circuitOpen && c.providerEnabled !== false &&
        plan.members.some(m => m.enabled && m.modelId === c.modelId && (!c.comboMemberId || m.id === c.comboMemberId)))
      .map(c => ({modelId:c.modelId,latency:reliableMedian(current.find(s => s.memberId === memberOf(plan,c)),now)}))
      .filter((c): c is {modelId:string;latency:number} => c.latency !== null)
      .sort((a,b) => a.latency-b.latency || a.modelId.localeCompare(b.modelId))[0];

    state.lastStartMs = startedAtMs;
    state.lastStartSequence = seq;
    state.updatedAtMs = now;
    state.lastOutcome = success ? 'success' : kind === 'success' ? 'error' : kind;
    if (observed && latency !== null) {
      state.lastLatencyMs = latency;
      state.lastObservationMs = now;
      state.consecutiveSlowCount = latency >= threshold ? Math.min(maxCount,state.consecutiveSlowCount+1) : 0;
      if (success) {
        const baseline = state.baselineLatencyMs ?? median(state.samples.map(s => s.latencyMs)) ?? latency;
        const suspect = latency > threshold*0.8 || (baseline > 0 && latency >= baseline*1.3);
        state.suspectCount = suspect ? Math.min(3,state.suspectCount+1) : 0;
        state.samples = [...state.samples,{latencyMs:latency,atMs:now}].slice(-SAMPLE_LIMIT);
        if (!suspect || state.baselineLatencyMs === null) state.baselineLatencyMs = Math.round(baseline === 0 ? latency : (suspect ? baseline : median(state.samples.map(s => s.latencyMs)) ?? latency));
      }
      const comparatorChanged = comparator?.modelId !== state.comparatorModelId;
      const ownMedian = reliableMedian(state,now);
      if (comparator && latency > comparator.latency + demotionMargin(comparator.latency) &&
          (state.degraded !== 'relative' || !comparatorChanged ||
            (ownMedian !== null && ownMedian > comparator.latency + demotionMargin(comparator.latency)))) {
        state.relativeSlowCount = Math.min(RELATIVE_SLOW_COUNT,(state.comparatorModelId === comparator.modelId ? state.relativeSlowCount : 0)+1);
        state.comparatorModelId = comparator.modelId;
      } else {
        state.relativeSlowCount = 0;
        // A relative demotion belongs to the comparator that justified it.
        // A new comparator must actually be faster; otherwise loss of the
        // original comparator would incorrectly pin this member again.
        if (state.degraded !== 'relative') state.comparatorModelId = comparator?.modelId ?? null;
      }
    }
    if (probe) {
      // Only this token owns the lease and may confirm recovery.
      state.probeToken = null;
      state.probeLeaseUntilMs = null;
      const qualifies = success && latency !== null &&
        (comparator ? latency <= comparator.latency + similarityMargin(comparator.latency) : latency < threshold);
      if (qualifies) {
        state.recoverySuccesses += 1;
        state.probeFailures = 0;
        if (state.recoverySuccesses >= 2) {
          state.degraded = null;
          state.probeDueMs = null;
          state.comparatorModelId = null;
          state.consecutiveSlowCount = 0;
          state.relativeSlowCount = 0;
          state.recoverySuccesses = 0;
          state.suspectCount = 0;
        } else {
          state.probeDueMs = now + CONFIRM_PROBE_DELAY_MS;
        }
      } else {
        state.recoverySuccesses = 0;
        state.probeDueMs = now + probeDelayMs(state.probeFailures,input.jitter ?? Math.random());
        state.probeFailures = Math.min(5,state.probeFailures+1);
      }
    } else if (observed) {
      // Normal/reserve successes update evidence but cannot confirm failback.
      // A censored timeout increments the slow count, never the sample ring.
      const relativeMedian = reliableMedian(state,now);
      // A slow-but-equivalent primary that has enough reliable evidence should
      // not be demoted again after two successful recovery probes. In an
      // all-slow pool we prefer the configured order inside the similarity band.
      const equivalentlySlow = comparator !== undefined && comparator.latency + similarityMargin(comparator.latency) >= threshold &&
        relativeMedian !== null && relativeMedian <= comparator.latency + similarityMargin(comparator.latency) &&
        success && latency !== null && latency <= comparator.latency + similarityMargin(comparator.latency);
      const absolute = state.consecutiveSlowCount >= maxCount && !equivalentlySlow;
      const relative = state.relativeSlowCount >= RELATIVE_SLOW_COUNT && state.samples.length >= MIN_COMPARABLE_SAMPLES &&
        comparator !== undefined && relativeMedian !== null && relativeMedian > comparator.latency + demotionMargin(comparator.latency);
      if (!state.degraded && (absolute || relative)) {
        state.degraded = absolute ? 'absolute' : 'relative';
        state.probeDueMs = now + INITIAL_PROBE_DELAY_MS;
        state.recoverySuccesses = 0;
        state.probeFailures = 0;
      } else if (state.degraded === 'relative' && absolute) {
        state.degraded = 'absolute';
      }
    }
    persistState(state);
  }).immediate();
}
