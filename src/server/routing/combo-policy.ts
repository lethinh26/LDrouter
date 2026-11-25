// Pure adaptive policy. No storage, upstream calls, clock or random source.
import type { CanonicalRequest } from './capabilities';
import type { CandidateModel, ComboPlan } from './combo';

export const SAMPLE_LIMIT = 5;
export const MIN_COMPARABLE_SAMPLES = 3;
export const SAMPLE_TTL_MS = 15 * 60_000;
export const RELATIVE_SLOW_COUNT = 3;
export const INITIAL_PROBE_DELAY_MS = 30_000;
export const CONFIRM_PROBE_DELAY_MS = 10_000;
export const MAX_PROBE_DELAY_MS = 300_000;
export const EXPLORATION_INTERVAL_MS = 60_000;

export interface AdaptiveSample { latencyMs: number; atMs: number }
export type AdaptiveRole = 'normal' | 'probe' | 'reserve' | 'replay' | 'explore';
export type AdaptiveOutcomeKind = 'success' | 'soft_timeout' | 'error' | 'cancel';
export interface AdaptiveState {
  comboId: string;
  memberId: string;
  modelId: string;
  workload: string;
  generation: number;
  samples: AdaptiveSample[];
  consecutiveSlowCount: number;
  relativeSlowCount: number;
  degraded: 'absolute' | 'relative' | null;
  comparatorModelId: string | null;
  probeDueMs: number | null;
  probeLeaseUntilMs: number | null;
  probeToken: string | null;
  recoverySuccesses: number;
  probeFailures: number;
  lastLatencyMs: number | null;
  lastOutcome: AdaptiveOutcomeKind | 'unknown';
  updatedAtMs: number;
  lastObservationMs: number | null;
  lastStartMs: number | null;
  lastStartSequence: number;
  baselineLatencyMs: number | null;
  suspectCount: number;
  explorationDueMs: number | null;
}

export const WORKLOADS: ReadonlySet<string> = new Set(
  ['plain','reasoning'].flatMap(reasoning => ['short','long'].flatMap(input => [
    `stream:${reasoning}:${input}`,
    `complete:${reasoning}:${input}:short`,
    `complete:${reasoning}:${input}:long`,
  ])),
);

/** Coarse, bounded token estimate: no raw prompt is retained in adaptive state. */
export function classifyWorkload(canonical: CanonicalRequest): string {
  // Stop walking as soon as the long-input bucket is certain. Unicode text is
  // approximated more conservatively than ASCII; multimedia is a long input.
  let estimated = 0;
  const addText = (value: string) => {
    for (let i = 0; i < value.length && estimated <= 8192; i++) {
      estimated += value.charCodeAt(i) < 128 ? 0.25 : 1;
    }
  };
  const addValue = (value: unknown) => {
    const pending: unknown[] = [value];
    const visited = new Set<object>();
    while (pending.length && estimated <= 8192) {
      const item = pending.pop();
      if (typeof item === 'string') addText(item);
      else if (item && typeof item === 'object' && !visited.has(item)) {
        visited.add(item);
        estimated += 1;
        if (Array.isArray(item)) {
          for (const child of item) { pending.push(child); if (pending.length > 8192) { estimated = 8193; break; } }
        } else {
          for (const key in item) {
            if (!Object.prototype.hasOwnProperty.call(item,key)) continue;
            addText(key);
            pending.push((item as Record<string, unknown>)[key]);
            if (estimated > 8192 || pending.length > 8192) { estimated = 8193; break; }
          }
        }
      } else if (item !== undefined) estimated += 1;
    }
  };
  if (canonical.system) addText(canonical.system);
  for (const message of canonical.messages) {
    if (estimated > 8192) break;
    for (const block of message.content) {
      if (block.type === 'image' || block.type === 'audio' || block.type === 'document') { estimated = 8193; break; }
      addValue(block.text ?? block.toolUse ?? block.toolResult);
      if (estimated > 8192) break;
    }
  }
  if (estimated <= 8192) addValue(canonical.tools);
  if (estimated <= 8192) addValue(canonical.responseFormat?.jsonSchema);
  const reasoning = canonical.reasoning ? 'reasoning' : 'plain';
  const input = estimated > 8192 ? 'long' : 'short';
  return canonical.stream
    ? `stream:${reasoning}:${input}`
    : `complete:${reasoning}:${input}:${canonical.maxOutputTokens !== undefined && canonical.maxOutputTokens <= 1024 ? 'short' : 'long'}`;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a,b) => a-b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid]! : (ordered[mid-1]! + ordered[mid]!) / 2;
}

export function freshSamples(samples: readonly AdaptiveSample[], now: number): AdaptiveSample[] {
  return samples.filter(s => Number.isFinite(s.latencyMs) && s.latencyMs >= 0 &&
    Number.isFinite(s.atMs) && s.atMs <= now && s.atMs >= now - SAMPLE_TTL_MS)
    .sort((a,b) => a.atMs - b.atMs).slice(-SAMPLE_LIMIT);
}

export function reliableMedian(state: AdaptiveState | undefined, now: number): number | null {
  const samples = freshSamples(state?.samples ?? [], now);
  return samples.length >= MIN_COMPARABLE_SAMPLES ? median(samples.map(s => s.latencyMs)) : null;
}

export function similarityMargin(referenceMs: number): number {
  return Math.max(2000, referenceMs * 0.2);
}

export function demotionMargin(referenceMs: number): number {
  return Math.max(3000, referenceMs * 0.3);
}

export function probeDelayMs(failures: number, jitter = 0): number {
  const base = Math.min(MAX_PROBE_DELAY_MS, INITIAL_PROBE_DELAY_MS * 2 ** Math.min(Math.max(failures,0),4));
  return Math.round(Math.min(MAX_PROBE_DELAY_MS, base * (1 + Math.max(0,Math.min(1,jitter))*0.1)));
}

export interface AdaptiveDecision {
  candidate: CandidateModel;
  role: AdaptiveRole;
  reason: string;
  softTimeout: boolean;
}

export interface AdaptivePickInput {
  candidates: CandidateModel[];
  plan: ComboPlan;
  states: AdaptiveState[];
  attempted: Set<string>;
  softTimedOut: Set<string>;
  replayed: boolean;
  now: number;
  /** Actual upstream dispatch count; skips do not consume this budget. */
  actualAttempts?: number;
  /** Suppress a probe after a failed lease claim without suppressing reserve serving. */
  blockedProbes?: Set<string>;
  allowExploration?: boolean;
}

export function pickAdaptiveCandidate(input: AdaptivePickInput): AdaptiveDecision | null {
  const {plan,states,attempted,softTimedOut,replayed,now} = input;
  const actualAttempts = input.actualAttempts ?? attempted.size;
  if (plan.enabled === false || actualAttempts >= plan.maxTotalAttempts) return null;
  const members = new Map(plan.members.filter(m => m.enabled).map(m => [m.modelId,m]));
  // Hard eligibility is refreshed by the caller; enforce the supplied flags here too.
  const pool = input.candidates.filter(c => {
    const member = members.get(c.modelId);
    return member && (!c.comboMemberId || c.comboMemberId === member.id) && c.enabled && c.upstreamAvailable && !c.circuitOpen && c.providerEnabled !== false;
  }).sort((a,b) => {
    const am = members.get(a.modelId)!; const bm = members.get(b.modelId)!;
    return am.position-bm.position || am.id.localeCompare(bm.id);
  });
  const available = pool.filter(c => !attempted.has(c.modelId));
  if (!plan.slowResponseFallbackEnabled) {
    return available[0] ? {candidate:available[0],role:'normal',reason:attempted.size ? 'fallback_after_error':'priority',softTimeout:false} : null;
  }
  const threshold = plan.slowResponseThresholdMs ?? 60_000;
  const stateFor = (c: CandidateModel) => states.find(s => s.modelId === c.modelId && s.memberId === members.get(c.modelId)?.id &&
    s.generation === (plan.slowResponseGeneration ?? 1));
  const latency = (c: CandidateModel) => reliableMedian(stateFor(c),now);
  const fresh = (s: AdaptiveState | undefined) => !!s && (s.lastObservationMs ?? s.updatedAtMs) >= now-SAMPLE_TTL_MS &&
    (s.lastObservationMs ?? s.updatedAtMs) <= now;
  const fasterComparator = (c: CandidateModel) => {
    const own = latency(c);
    if (own === null) return false;
    return available.some(other => {
      if (other.modelId === c.modelId) return false;
      const speed = latency(other);
      return speed !== null && own > speed + demotionMargin(speed);
    });
  };
  const isReserve = (c: CandidateModel) => {
    const s = stateFor(c);
    if (!fresh(s)) return false;
    if (s!.degraded === 'absolute') return true;
    if (s!.degraded !== 'relative') return false;
    // Loss of the comparator releases relative demotion immediately. Another
    // reliable, hard-eligible faster model can supply fresh comparative evidence.
    const own = latency(c);
    if (own === null) return false;
    const comparator = available.find(other => other.modelId === s!.comparatorModelId);
    const reference = comparator ? latency(comparator) : null;
    // Keep the hysteresis band until two qualifying probes have confirmed recovery.
    return reference !== null || fasterComparator(c);
  };
  const knownSlow = (c: CandidateModel) => {
    const ms = latency(c);
    const state = stateFor(c);
    return (ms !== null && ms >= threshold) ||
      (fresh(state) && state?.degraded === 'absolute' && state.consecutiveSlowCount > 0);
  };
  const allSlow = available.length > 0 && available.every(knownSlow);
  const mayWatch = (candidate: CandidateModel, role: AdaptiveRole) => {
    if (role === 'reserve' || role === 'replay' || allSlow || actualAttempts+1 >= plan.maxTotalAttempts) return false;
    if (role === 'probe') {
      const references = available.filter(c => c.modelId !== candidate.modelId).map(latency)
        .filter((v): v is number => v !== null);
      // When the fastest comparator is itself near the soft threshold, a
      // qualifying recovery response may take longer than that threshold.
      if (references.length && Math.min(...references) + similarityMargin(Math.min(...references)) >= threshold) return false;
    }
    const current = latency(candidate);
    return available.some(other => {
      if (other.modelId === candidate.modelId || knownSlow(other)) return false;
      const speed = latency(other);
      return speed === null || current === null || current > speed + similarityMargin(speed);
    });
  };
  const decision = (candidate: CandidateModel,role: AdaptiveRole,reason: string): AdaptiveDecision =>
    ({candidate,role,reason,softTimeout:mayWatch(candidate,role)});
  // Among reserves, select the first member within tolerance of the fastest
  // reliable one. An unknown primary retains priority, not a fabricated speed.
  const chooseReserve = (candidates: CandidateModel[]): CandidateModel | undefined => {
    const first = candidates[0];
    if (!first || latency(first) === null) return first;
    const values = candidates.map(latency).filter((v): v is number => v !== null);
    const fastest = Math.min(...values);
    return candidates.find(c => { const ms = latency(c); return ms !== null && ms <= fastest + similarityMargin(fastest); }) ?? first;
  };
  const normal = available.filter(c => !isReserve(c));
  const chosenNormal = normal[0];
  const rank = chosenNormal ? pool.indexOf(chosenNormal) : Number.POSITIVE_INFINITY;
  const probe = available.find(c => {
    const s = stateFor(c);
    return isReserve(c) && pool.indexOf(c) < rank && s?.probeDueMs != null && s.probeDueMs <= now &&
      (s.probeLeaseUntilMs === null || s.probeLeaseUntilMs <= now) && !input.blockedProbes?.has(c.modelId);
  });
  if (probe) return decision(probe,'probe','recovery_probe');

  if (chosenNormal) {
    const primary = pool[0];
    const state = primary && stateFor(primary);
    if (!attempted.size && chosenNormal === primary && input.allowExploration !== false &&
        state && fresh(state) && (state.explorationDueMs == null || state.explorationDueMs <= now)) {
      const samples = freshSamples(state.samples,now);
      const suspect = state.suspectCount >= 3 || (samples.length >= 3 &&
        samples.slice(-3).every(s => s.latencyMs > 0.8*threshold));
      const backups = normal.slice(1);
      if (suspect && backups.length && !backups.some(c => latency(c) !== null)) {
        const explore = backups.find(c => latency(c) === null);
        if (explore) return decision(explore,'explore','exploratory_sample');
      }
    }
    return decision(chosenNormal,'normal',attempted.size ? 'fallback_after_error' : chosenNormal === pool[0] ? 'priority' : 'relative_faster');
  }

  const reserve = chooseReserve(available);
  if (reserve) return decision(reserve,'reserve',allSlow ? 'all_slow':'slow_reserve');
  if (!replayed && actualAttempts < plan.maxTotalAttempts) {
    const replay = chooseReserve(pool.filter(c => attempted.has(c.modelId) && softTimedOut.has(c.modelId)));
    if (replay) return decision(replay,'replay','rescue_replay');
  }
  return null;
}
