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
  -> skip combo members in slow-response cooldown
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
- total request timeout before downstream content is committed
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

## Ordered fallback

Combo members are tried in their saved `position` order. The first eligible member is selected;
later members are attempted only when the configured fallback policy allows it.

Requirements:

- disabled/unhealthy/incompatible candidates are skipped
- ordering is deterministic and visible in the admin UI
- a failed first candidate may still enter fallback/retry behavior according to combo policy

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
- `fallback_on_total_timeout` is independent from connect and first-token timeout triggers; migration 0012 seeds existing combos from their former `fallback_on_connect_timeout` preference to preserve behavior

Never multiply retries without a global cap.

An upstream HTTP 200 with zero generated output tokens and no assistant text or tool calls is
an `upstream_empty_response` failure (HTTP 502 to the client if no attempt succeeds), even if
the upstream reports consumed input tokens. Retry the same provider model up to its configured
`max_retries` for this failure, honoring the combo's `max_total_attempts` limit and reserving an
attempt for the next combo model where possible. Empty-response fallback respects the combo's
HTTP 5xx fallback setting. Streaming prelude/usage events do not commit a downstream HTTP 200;
the stream commits on the first actual text or tool call. Once streaming output has been sent,
fallback is prohibited. A valid tool call or real text still counts as generated output when a
provider omits usage statistics or reports zero output tokens.
Legacy cached empty successes are evicted when read, allowing the live upstream to be retried.

## Slow-response fallback

Each combo can enable slow-response fallback (enabled by default) with:

- `slow_response_threshold_seconds`: default 60 seconds, range 1–600
- `slow_response_max_count`: default 3 consecutive slow outcomes, range 1–20

The measured interval depends on the response mode:

- streaming: request start until the first actual text or tool-call content (TTFT); SSE metadata,
  role/start events, and usage-only events do not satisfy the first-token watchdog
- non-streaming: request start until the complete response body is received

Provider `first_token_timeout` starts after response headers, while the combo TTFT threshold starts
at the upstream request. Provider `total_timeout` also starts at the request. The first absolute
deadline reached applies; a numerically shorter provider first-token timeout can still expire later
when connection/header latency is high.

When the threshold is reached, the current attempt is aborted before downstream content is
committed and the combo advances to the next member. A slow outcome increments that member's
consecutive count. A fast streaming TTFT or completed non-streaming response resets the count.
After the configured count, the member is skipped for five minutes. When cooldown expires, one
request obtains an atomic probe lease; concurrent requests skip that member until the probe ends.
A fast probe clears the state, while a failed or slow probe starts another five-minute cooldown.
Slow-response timeouts are tracked per combo-member and do not open the provider-wide circuit.
Slow-state writes and recovery-probe operations are bound to the captured `combo_members.id`, so a
late request from a removed membership cannot mutate a later re-added membership for the same model.

The normal `max_total_attempts` cap still applies to all attempts in a request, including slow
response fallbacks. A combo must have enough attempts configured to reach its later members.

## Timeouts

Separate at least:

- TCP/connect timeout
- time to first meaningful upstream response/token
- streaming idle timeout
- total request timeout

Defaults must be conservative and editable.

Timeouts must use abort signals so abandoned upstream requests do not continue consuming resources unnecessarily.
Connect timeout ends when upstream response headers arrive. The first-token watchdog remains
armed through metadata-only SSE events and ends only on actual generated content.
For a non-2xx response, the known HTTP status remains the fallback signal even if reading its error
body reaches the provider total deadline; the total deadline still aborts that body read.

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
