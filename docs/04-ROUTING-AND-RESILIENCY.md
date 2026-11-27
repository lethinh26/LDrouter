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
  -> order hard-eligible candidates using adaptive latency history when enabled
  -> revalidate and select before each dispatch
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

Saved `position` defines priority. With adaptive routing disabled, the first eligible member wins.
With it enabled, convincing latency evidence may temporarily lower a member's priority; similar
latency always favors the earlier member. Later attempts still obey the configured failure triggers.

Requirements:

- disabled, circuit-blocked, or incompatible candidates are skipped; slow members are reserves
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

- `max_total_attempts` caps actual upstream dispatches across retries, fallback and rescue; skips do not consume attempts
- optional `max_request_duration_seconds` (1–3600; null by default) caps the entire combo execution, including retry delays
- `fallback_on_total_timeout` is independent from connect and first-token timeout triggers; migration 0012 seeds existing combos from their former `fallback_on_connect_timeout` preference to preserve behavior

Never multiply retries without a global cap.

An otherwise well-formed upstream HTTP 200 with no deliverable generation (text, refusal,
valid tool call, or supported reasoning) is an `upstream_empty_response` failure (HTTP 502
if no attempt succeeds), regardless of reported token usage. Retry the same provider model up to its configured
`max_retries` for this failure, honoring the combo's `max_total_attempts` limit and reserving an
attempt for the next combo model where possible. Empty-response fallback respects the combo's
HTTP 5xx fallback setting. Streaming prelude/usage events do not commit a downstream HTTP 200;
the stream commits on the first deliverable generated token, including same-family reasoning,
text, refusal or a valid tool call. Once streaming output has been sent, fallback is prohibited.
Reasoning is preserved separately from answer text. A reasoning-only length/max_tokens termination
is a valid truncated generation; reasoning-only normal termination without an answer is incomplete.
Metadata prelude limits, invalid framing, incompatible content types and premature EOF are bad
responses rather than empty generations. Valid output counts even when usage is absent or zero.
Legacy cached empty successes are evicted when read, allowing the live upstream to be retried.

## Adaptive ordered fallback

Each combo can enable adaptive ordered fallback (enabled by default, using the existing `slow_response_fallback_enabled` setting) with:

- `slow_response_threshold_seconds`: default 60 seconds, range 1–600
- `slow_response_max_count`: default 3 consecutive slow outcomes, range 1–20

The measured interval depends on the response mode:

- streaming: request start until the first deliverable generated token (TTFT), including supported
  reasoning, text, refusal or a valid tool call; SSE metadata, role/start events, and usage-only
  events do not satisfy the first-token watchdog. Hard idle/total deadlines continue after TTFT.
- non-streaming: request start until the complete response body is received

Provider `first_token_timeout` starts after response headers, while the combo TTFT threshold starts
at the upstream request. Provider `total_timeout` also starts at the request. The first absolute
deadline reached applies; a numerically shorter provider first-token timeout can still expire later
when connection/header latency is high.

Latency history is scoped to a member and a bounded workload (streaming/completion, reasoning,
input size, and non-stream output budget). Only valid, completed generations contribute successful
latency samples. Use the median of up to five samples within 15 minutes, requiring three samples
for relative comparisons. Demote after three consecutive observations exceeding the comparator
by max(3 seconds, 30%); restore priority within max(2 seconds, 20%). The distinct thresholds
avoid oscillation. The configured absolute slow count can also trigger degradation. Missing or
stale evidence cannot permanently favor a lower-priority model.
After the TTFT definition changes, older samples expire via the existing 15-minute window;
no stored routing state is reset as part of the parser update.

Degradation is a soft reserve, not unavailability. When an alternative could be faster, the
soft watchdog can abort an attempt before downstream commitment. The last viable model, a
reserve/rescue, or a group with similarly slow known models can run until its hard timeout.
If the fallback fails, previously demoted members become available immediately. An attempt
aborted only by the soft watchdog may be replayed once if all untried candidates are exhausted,
fallback is allowed, and both the attempt cap and deadline permit it. No parallel inference is sent.

Recovery starts with a real request after 30 seconds; a lease admits one probe per member/workload.
Two successful comparable probes (second due after 10 seconds) restore normal priority. A failed
probe backs off up to five minutes. A probe cannot promote a member after partial stream failure.
Other traffic can use ready members, or serve degraded members if no ready alternative remains.
Limited exploration can sample an unknown backup when the primary has repeated evidence of slowness.
Recovery/exploration are passive: no traffic means no background inference. Synthetic admin tests
do not train the routing state or read/write the response cache.

All state changes are fenced by membership, configuration generation, attempt ordering and lease
ownership. Config changes, restart and restore cannot leave an old probe in control. Hard eligibility,
capabilities, API-key policy and provider circuits remain mandatory on every dispatch. Soft timeout
alone never opens a provider-wide circuit. The configured attempt cap includes rescue replays;
with a cap of two, an A → B → A sequence cannot complete its third dispatch.

## Timeouts

Separate at least:

- TCP/connect timeout
- time to first meaningful upstream response/token
- streaming idle timeout
- total request timeout
- optional combo-wide overall deadline, including retry delays

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

Only failure categories indicating upstream health should trip the circuit. Client validation and
model-specific failures must not trip a provider-wide circuit. One half-open probe at a time can
test recovery; success means a complete valid response, not merely the first streaming token.

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
