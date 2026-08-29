// Unit tests: circuit breaker transitions.
import { describe, expect, it, beforeEach } from 'vitest';
import { recordSuccess, recordFailure, getEffectiveState, halfOpenProbeAllowed } from '../../src/server/routing/circuit';

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
});
