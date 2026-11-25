// In-memory provider circuit. Claims are synchronous and never held across a DB transaction.
interface CircuitState {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openedAt: number;
  epoch: number;
  probeToken: number | null;
  throttledUntil: number;
}

export interface CircuitPermit {
  readonly epoch: number;
  readonly probeToken: number | null;
}

const store = new Map<string, CircuitState>();
const modelThrottleUntil = new Map<string, number>();
let nextToken = 0;
let nextEpoch = 0;

/** A restored database may reuse provider IDs, but not old in-flight permits. */
export function resetCircuits(): void {
  store.clear();
  modelThrottleUntil.clear();
}

function stateFor(providerId: string): CircuitState {
  let s = store.get(providerId);
  if (!s) {
    s = { state: 'closed', consecutiveFailures: 0, openedAt: 0, epoch: ++nextEpoch, probeToken: null, throttledUntil: 0 };
    store.set(providerId, s);
  }
  return s;
}

export function circuitState(providerId: string): 'closed' | 'open' | 'half_open' {
  return store.get(providerId)?.state ?? 'closed';
}

export function isOpen(providerId: string): boolean {
  return circuitState(providerId) === 'open';
}

function owns(s: CircuitState, permit: CircuitPermit): boolean {
  return s.epoch === permit.epoch && (permit.probeToken === null
    ? s.state === 'closed'
    : s.state === 'half_open' && s.probeToken === permit.probeToken);
}

/** No await between checking and claiming; one half-open probe across all models. */
export function claimCircuitAttempt(providerId: string, cooldownSeconds: number): CircuitPermit | null {
  const s = stateFor(providerId);
  getEffectiveState(providerId, cooldownSeconds);
  if (s.throttledUntil > Date.now() || s.state === 'open') return null;
  if (s.state === 'closed') return { epoch: s.epoch, probeToken: null };
  if (s.probeToken !== null) return null;
  s.probeToken = ++nextToken;
  return { epoch: s.epoch, probeToken: s.probeToken };
}

/** Cancel/soft timeout/pre-dispatch rollback never resolves a half-open probe. */
export function releaseCircuitAttempt(providerId: string, permit: CircuitPermit): void {
  const s = store.get(providerId);
  if (s && permit.probeToken !== null && owns(s, permit)) s.probeToken = null;
}

/** No-token calls are explicit resets (e.g. admin/tests); runtime always supplies its permit. */
export function recordSuccess(providerId: string, permit?: CircuitPermit): boolean {
  const s = stateFor(providerId);
  if (permit && !owns(s, permit)) return false;
  const resetEpoch = !permit || s.state !== 'closed';
  s.state = 'closed';
  s.consecutiveFailures = 0;
  s.openedAt = 0;
  s.probeToken = null;
  if (resetEpoch) s.epoch = ++nextEpoch;
  if (!permit) s.throttledUntil = 0;
  return true;
}

export function recordFailure(providerId: string, threshold: number, _cooldownSeconds: number, permit?: CircuitPermit): boolean {
  const s = stateFor(providerId);
  if (permit && !owns(s, permit)) return false;
  s.consecutiveFailures += 1;
  if (s.state === 'half_open' || s.consecutiveFailures >= threshold) {
    s.state = 'open';
    s.openedAt = Date.now();
    s.probeToken = null;
    s.epoch = ++nextEpoch;
  }
  return true;
}

/** Honor a known transient provider throttle without treating quota as a hard failure. */
export function recordThrottle(providerId: string, retryAfterMs: number, permit: CircuitPermit): void {
  const s = store.get(providerId);
  if (s && owns(s, permit) && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    s.throttledUntil = Math.max(s.throttledUntil, Date.now() + retryAfterMs);
  }
}

/** An explicitly model-scoped throttle must not block sibling models. */
export function recordModelThrottle(modelId: string, retryAfterMs: number, owner?: { providerId: string; permit: CircuitPermit }): void {
  if (owner) {
    const s = store.get(owner.providerId);
    if (!s || !owns(s, owner.permit)) return;
  }
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
  modelThrottleUntil.set(modelId, Math.max(modelThrottleUntil.get(modelId) ?? 0, Date.now() + retryAfterMs));
}

export function modelThrottleBlocks(modelId: string): boolean {
  const until = modelThrottleUntil.get(modelId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  modelThrottleUntil.delete(modelId);
  return false;
}

export function getEffectiveState(providerId: string, cooldownSeconds: number): 'closed' | 'open' | 'half_open' {
  const s = store.get(providerId);
  if (!s) return 'closed';
  if (s.state === 'open' && Date.now() - s.openedAt >= cooldownSeconds * 1000) {
    s.state = 'half_open';
    s.probeToken = null;
  }
  return s.state;
}

export function halfOpenProbeAllowed(providerId: string): boolean {
  const s = store.get(providerId);
  return s?.state === 'half_open' && s.probeToken === null && s.throttledUntil <= Date.now();
}

export function circuitBlocks(providerId: string, cooldownSeconds: number): boolean {
  const state = getEffectiveState(providerId, cooldownSeconds);
  const s = store.get(providerId);
  return state === 'open' || (state === 'half_open' && s?.probeToken !== null) || (s?.throttledUntil ?? 0) > Date.now();
}
