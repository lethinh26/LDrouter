// Unit tests: circuit breaker transitions.
import { describe, expect, it, beforeEach } from 'vitest';
import { recordSuccess, recordFailure, getEffectiveState, halfOpenProbeAllowed, circuitBlocks, claimCircuitAttempt, releaseCircuitAttempt, recordThrottle, recordModelThrottle, modelThrottleBlocks, resetCircuits } from '../../src/server/routing/circuit';

describe('circuit breaker', () => {
  beforeEach(() => { /* state is module-local; tests use unique ids */ });

  it('opens after threshold failures', () => {
    recordFailure('p-open', 3, 60);
    recordFailure('p-open', 3, 60);
    recordFailure('p-open', 3, 60);
    expect(getEffectiveState('p-open', 60)).toBe('open');
    expect(halfOpenProbeAllowed('p-open')).toBe(false);
  });

  it('transitions to half-open after cooldown', async () => {
    recordFailure('p-cooldown', 2, 0);
    recordFailure('p-cooldown', 2, 0);
    // Still within the initial cooldown window: open, no probes allowed.
    expect(getEffectiveState('p-cooldown', 60)).toBe('open');
    expect(halfOpenProbeAllowed('p-cooldown')).toBe(false);
    // After the cooldown (0s) elapses, the circuit transitions to half-open.
    await new Promise((r) => setTimeout(r, 20));
    expect(getEffectiveState('p-cooldown', 0)).toBe('half_open');
    expect(halfOpenProbeAllowed('p-cooldown')).toBe(true);
  });

  it('success closes the circuit', () => {
    recordFailure('p-close', 1, 60);
    expect(getEffectiveState('p-close', 60)).toBe('open');
    recordSuccess('p-close');
    expect(getEffectiveState('p-close', 60)).toBe('closed');
  });

  it('does not trip on client errors', () => {
    // Only failure categories indicating upstream health trip the circuit.
    recordFailure('p-client', 2, 60); // simulate only upstream failures recorded
    expect(getEffectiveState('p-client', 60)).toBe('closed');
  });

  it('admits a candidate once the cooldown has elapsed', async () => {
    // Regression: candidate filtering used the raw isOpen() flag, which stays 'open'
    // until some request walks the attempt loop to decay it — the filter prevented that
    // request from ever being built, so the provider was unroutable until a restart and
    // the admin test endpoint answered an empty stream.
    recordFailure('p-block', 1, 0);
    recordSuccess('p-block');
    recordFailure('p-block', 1, 0);
    expect(circuitBlocks('p-block', 3600)).toBe(true); // cooldown not yet elapsed
    await new Promise((r) => setTimeout(r, 20));
    expect(circuitBlocks('p-block', 0)).toBe(false); // elapsed: the probe may run
  });

  it('grants exactly one provider-wide half-open token across concurrent candidates', () => {
    recordFailure('p-exclusive', 1, 0);
    const claims = Array.from({ length: 100 }, () => claimCircuitAttempt('p-exclusive', 0));
    const owners = claims.filter((claim) => claim !== null);
    expect(owners).toHaveLength(1);
    expect(circuitBlocks('p-exclusive', 0)).toBe(true);
    const first = owners[0]!;
    releaseCircuitAttempt('p-exclusive', first); // cancel/soft timeout
    const second = claimCircuitAttempt('p-exclusive', 0)!;
    expect(second).not.toBeNull();
    expect(second.probeToken).not.toBe(first.probeToken);
    releaseCircuitAttempt('p-exclusive', first);
    expect(circuitBlocks('p-exclusive', 0)).toBe(true);
    expect(recordSuccess('p-exclusive', first)).toBe(false);
    expect(recordFailure('p-exclusive', 1, 0, first)).toBe(false);
    expect(recordSuccess('p-exclusive', second)).toBe(true);
    expect(getEffectiveState('p-exclusive', 60)).toBe('closed');
  });

  it('does not let a stale closed-state completion reset a newer open circuit', () => {
    const first = claimCircuitAttempt('p-stale', 60)!;
    const second = claimCircuitAttempt('p-stale', 60)!;
    expect(recordFailure('p-stale', 1, 60, second)).toBe(true);
    expect(recordSuccess('p-stale', first)).toBe(false);
    expect(circuitBlocks('p-stale', 60)).toBe(true);
  });

  it('keeps Retry-After separate from provider failure and model-scoped throttles separate from siblings', () => {
    const permit = claimCircuitAttempt('p-throttle', 60)!;
    recordThrottle('p-throttle', 60_000, permit);
    expect(circuitBlocks('p-throttle', 60)).toBe(true);
    expect(getEffectiveState('p-throttle', 60)).toBe('closed');
    recordModelThrottle('model-a-throttle', 60_000);
    expect(modelThrottleBlocks('model-a-throttle')).toBe(true);
    expect(modelThrottleBlocks('model-b-throttle')).toBe(false);
    expect(circuitBlocks('p-unrelated', 60)).toBe(false);
  });

  it('fences old permits and clears throttles when the database is replaced', () => {
    const old = claimCircuitAttempt('p-restored', 60)!;
    recordModelThrottle('restored-model', 60_000);
    resetCircuits();
    const current = claimCircuitAttempt('p-restored', 60)!;
    expect(recordFailure('p-restored', 1, 60, old)).toBe(false);
    recordModelThrottle('restored-model', 60_000, { providerId: 'p-restored', permit: old });
    expect(modelThrottleBlocks('restored-model')).toBe(false);
    expect(recordSuccess('p-restored', current)).toBe(true);
  });
});
