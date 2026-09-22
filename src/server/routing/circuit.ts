// In-memory circuit breaker state per provider.


interface CircuitState {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openedAt: number;
}

const store = new Map<string, CircuitState>();

export function circuitState(providerId: string): 'closed' | 'open' | 'half_open' {
  const s = store.get(providerId);
  if (!s) return 'closed';
  return s.state;
}

export function isOpen(providerId: string): boolean {
  return circuitState(providerId) === 'open';
}

export function recordSuccess(providerId: string): void {
  store.set(providerId, { state: 'closed', consecutiveFailures: 0, openedAt: 0 });
}

export function recordFailure(providerId: string, threshold: number, _cooldownSeconds: number): void {
  const s = store.get(providerId) ?? { state: 'closed', consecutiveFailures: 0, openedAt: 0 };
  s.consecutiveFailures += 1;
  if (s.state === 'half_open' || s.consecutiveFailures >= threshold) {
    s.state = 'open';
    s.openedAt = Date.now();
    // Auto-transition to half-open after cooldown via getEffectiveState
  }
  store.set(providerId, s);
}

export function getEffectiveState(providerId: string, cooldownSeconds: number): 'closed' | 'open' | 'half_open' {
  const s = store.get(providerId);
  if (!s) return 'closed';
  if (s.state === 'open' && Date.now() - s.openedAt > cooldownSeconds * 1000) {
    s.state = 'half_open';
    store.set(providerId, s);
  }
  return s.state;
}

export function halfOpenProbeAllowed(providerId: string): boolean {
  return circuitState(providerId) === 'half_open';
}

/**
 * Should the candidate filter refuse this provider outright?
 *
 * `isOpen()` reports the raw state, which stays `'open'` until a request walks the
 * attempt loop — so a tripped breaker rejected every candidate for the lifetime of the
 * process and made the provider unroutable until a restart (the combo path and the
 * direct-model path both read the flag off the candidate record). A candidate must be
 * allowed through once the cooldown has elapsed so the probe that closes the breaker
 * can actually run; `getEffectiveState` is what performs that open -> half_open decay.
 */
export function circuitBlocks(providerId: string, cooldownSeconds: number): boolean {
  return getEffectiveState(providerId, cooldownSeconds) === 'open';
}
