# 04 — Routing and Resiliency

## Candidate pipeline

For every request, determine candidate physical models in this order:

```text
requested model/alias
  -> resolve physical model or combo
  -> apply API-key ACL
  -> remove disabled models/providers
  -> remove upstream-unavailable models
  -> remove models with open circuit
  -> derive required capabilities from request
  -> remove incompatible candidates
  -> apply combo routing algorithm
```

If no candidates remain, return a clear gateway error explaining the category without leaking sensitive configuration.

## Fallback combos

A fallback combo has an ordered member list.

Example:

```text
combo/coding
1. latedev/gpt-5.5
2. backup/gpt-5.5
3. anthropic/claude-x
```

Each combo stores which failure classes trigger fallback.

Recommended defaults:

Fallback:

- connection failure
- connection timeout
- first-token timeout before stream starts
- HTTP 408
- HTTP 429
- HTTP 500-599

Do not fallback by default:

- malformed client request / 400
- client gateway authentication failure / 401
- key/model authorization failure / 403
- unsupported capability
- request too large
- upstream authentication/configuration error caused by a bad provider credential, unless the admin explicitly enables that behavior

The admin UI must allow toggling retry/fallback error categories per combo/provider where sensible.

## Weighted round robin

Support positive integer weights.

Example:

```text
model A weight 5
model B weight 3
model C weight 2
```

Long-run target distribution is approximately 50/30/20 among healthy eligible candidates.

Requirements:

- disabled/unhealthy/incompatible candidates are skipped
- selection state is safe under concurrent requests
- a failed first candidate may still enter fallback/retry behavior according to combo policy
- distribution tests must avoid asserting exact order under concurrency; test statistically/deterministically through injectable routing state

## Retry policy

Provider-level retry config:

- max retries
- base retry delay
- max retry delay
- exponential backoff
- jitter
- retryable status/error classes

Combo-level safety:

- `max_total_attempts` caps the entire client request across retries and fallbacks

Never multiply retries without a global cap.

## Timeouts

Separate at least:

- TCP/connect timeout
- time to first meaningful upstream response/token
- streaming idle timeout
- total request timeout

Defaults must be conservative and editable.

Timeouts must use abort signals so abandoned upstream requests do not continue consuming resources unnecessarily.

## Health

Expose provider/model operational states such as:

- healthy
- degraded
- down
- circuit_open/cooldown
- unknown

Track at runtime:

- last success
- last failure
- consecutive failures
- rolling error count/rate
- average recent latency
- p95 recent latency if feasible

Do not make health checks expensive. Prefer lightweight provider checks and passive health derived from actual traffic. A manual **Test Connection** action should test authentication/model-listing and optionally a minimal generation path where configured.

## Circuit breaker

Implement a simple state machine:

```text
CLOSED -> OPEN -> HALF_OPEN -> CLOSED
                   | failure
                   +--------> OPEN
```

Configurable fields:

- consecutive failure threshold
- cooldown duration
- half-open probe behavior

Only failure categories indicating upstream health should trip the circuit. Client validation failures must not.

## Capability-aware routing

Derive required capabilities before choosing a candidate.

Examples:

- `stream=true` => streaming required
- tools present => tool calling required
- image content => image input required
- strict JSON schema => structured output required
- Responses-only feature => compatible Responses semantics required

For a combo, the UI should warn when member capabilities differ. Runtime filtering is still mandatory.

## Physical model requests

A direct physical model request does not fallback to an unrelated model unless explicitly routed through a configured alias/combo. Direct means direct.

## Determinism and logging

Every attempt records why it was selected and why it ended, using non-sensitive reason codes. This is essential for debugging routing.

Read next: `05-API-KEYS-LIMITS-AND-IP.md`.
