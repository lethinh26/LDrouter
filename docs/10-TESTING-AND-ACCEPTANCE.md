# 10 — Testing and Acceptance Criteria

This document is the final completion gate. The autonomous agent must keep implementing/fixing until these criteria pass.

## Test layers

### Unit tests

Cover pure logic:

- model/public ID generation
- alias resolution
- combo candidate filtering
- fallback decision matrix
- HTTP 408 preserves its upstream status and obeys the combo's `fallback_on_408` toggle
- non-streaming total timeout obeys `fallback_on_total_timeout`; repeated total timeouts count toward provider circuit health
- connect timeout aborts streaming and non-streaming requests before response headers
- metadata-only SSE events do not stop the first-token watchdog
- adaptive workload history, median, freshness, relative/absolute demotion and hysteresis
- exclusive recovery lease, two successful probes, backoff, generation and stale-outcome fencing
- ordered combo routing
- retry/backoff calculations
- circuit breaker transitions
- CIDR parsing/matching IPv4 + IPv6
- trusted proxy/client-IP resolution
- API-key hashing/verification
- secret redaction
- capability requirement derivation
- protocol field mappings
- retention date calculations

### Integration tests

Run server against temporary SQLite database and mock upstream HTTP servers.

Cover:

- migrations from empty DB
- adaptive migration defaults, reset of unsegmented cooldown data, history preservation, and foreign-key integrity
- first-run admin setup
- login/session/logout
- TOTP enable/verify/recovery/disable
- provider creation with encrypted secret
- provider secret is decryptable for use but not visible in DB/API/logs
- model discovery without automatic import
- selective model import
- Select All backend import behavior
- stale upstream model becomes unavailable, not deleted
- key generation starts with `ld-`
- plaintext key absent from DB
- key expiry
- model ACL
- IP allow/deny
- RPM/TPM/concurrency enforcement
- OpenAI model list filtered by key
- OpenAI chat completion non-streaming
- OpenAI chat completion streaming
- OpenAI Responses non-streaming/streaming supported subset
- Anthropic Messages non-streaming
- Anthropic Messages streaming
- Anthropic model list
- Anthropic token counting supported/unsupported behavior
- tools/function calls mapping
- capability mismatch returns pre-upstream error
- request and attempt logs
- error sanitization
- statistics ranges
- provider prompt-cache token accounting
- gateway response cache exact-key hit/miss behavior
- gateway cache disabled-by-default behavior
- gateway cache TTL/invalidation/clear behavior
- streaming bypasses gateway response cache
- retention cleanup
- audit logging
- backup creation
- invalid restore rejection
- valid restore and rollback safety
- `/health`, `/ready`, `/metrics`

### E2E browser tests

Critical flows:

1. First run -> create admin -> login.
2. Add an OpenAI-compatible provider -> Test Connection -> Fetch Models -> select two models only -> import.
3. Add an Anthropic-compatible provider -> fetch/select/import.
4. Create fallback combo.
5. Reorder combo members and confirm the saved priority is used.
6. Create API key with model restriction, expiry, CIDR, and limits -> copy-once dialog appears.
7. Requests page shows success/failure and expandable attempt/error detail.
8. Statistics preset switching works.
9. Change log retention.
10. Configure TOTP 2FA.
11. Download backup.
12. Upload valid backup through restore validation UI.

## Routing acceptance scenarios

### Fallback before streaming starts

Mock model A returns 429 before body data; model B returns 200.

Expected:

- one gateway request
- two attempts
- final success
- fallback count incremented
- client gets only model B's response

### Stream failure after content was sent

Model A sends valid stream content and then connection fails.

Expected:

- no fallback to model B in the same response
- attempt marked `stream_started=true`
- attempt/request marked partial/failure appropriately
- logs contain sanitized failure

### Capability filtering

Combo has A(tools yes) + B(tools no). Client sends tool definitions.

Expected:

- B is not selected
- if A unavailable and no other capable member exists, gateway returns capability/unavailable error rather than routing to B

### Ordered combo routing

With deterministic member positions, confirm the first eligible model is tried first and unavailable
models are skipped in favor of later members.

### Adaptive ordered fallback

Configure a combo with a one-second threshold, three consecutive slow outcomes, and two members.
Make the first member exceed the threshold on three requests while the second member responds
quickly.

Expected:

- each slow attempt is aborted and the current request succeeds through member two
- the first member becomes a soft reserve after three slow outcomes; the next request selects member two
- when member two fails or is circuit-blocked, member one can serve immediately without waiting for recovery
- if both are slow, the final viable model gets its hard deadline rather than a soft abort
- soft-aborted A can replay once after B fails (cap 3); cap 2 forbids the third dispatch
- similar measured speeds favor member one; substantial sustained differences demote it
- one recovery probe per member/workload is admitted; two comparable successes restore priority
- stale data, comparator failure, configuration changes and expired leases cannot pin or resurrect stale state
- deadline exhaustion, caller disconnect, fallback trigger off, cache hits, and synthetic admin requests obey their distinct rules
- for streaming, metadata-only SSE events do not count as TTFT and no content from the slow member
  reaches the client before fallback
- once real text, refusal, tool output or same-family reasoning is sent, later stream errors still never fallback
- more than 128 reasoning events or 64 KiB before the answer still returns the full answer exactly once;
  reasoning satisfies TTFT, role/usage/ping alone do not
- genuine empty generations still retry/fallback within configured limits; malformed/oversized SSE
  and premature EOF are distinguished from empty generations and never produce fabricated success
- split UTF-8 and multiline SSE preserve exact content, and DONE/message_stop ends reading without
  waiting for the upstream socket to close

## Security acceptance

Automated scan/assertions confirm that none of these appear in persisted logs or normal error payloads:

- plaintext `ld-` API key
- upstream provider key
- Authorization header value
- cookie/session token
- master encryption key
- TOTP secret

DB inspection confirms:

- admin password is hashed
- gateway key is digested only
- provider key is ciphertext
- TOTP secret is ciphertext
- recovery codes are hashed

## Backup acceptance

### Legacy safety (must remain passing)

- backup while service is active is consistent
- checksum mismatch is rejected
- non-SQLite/random upload is rejected
- future unsupported schema is rejected
- restore failure preserves original live DB
- master key is not contained in backup metadata

Proven by `tests/integration/backup-restore.test.ts` (hot restore, invalid-backup rejection, master-key switch) and `tests/integration/backup-restore-upload.test.ts` (checksum/gzip/SQLite/passphrase rejection without touching live state).

### Compact / full export

- a compact export drops every excluded table (`requests`, `request_attempts`, `audit_logs`, `response_cache`, `admin_sessions`, `csrf_tokens`, `backups`) while retaining configuration and the daily aggregate tables
- a full export keeps raw request, attempt, audit, and cache rows
- the compact export is materially smaller than the full export
- the v2 `.ldb` container manifest and checksum match the compressed payload, and no snapshot/gzip temp files are left behind
- the create route serves a streamed `.ldb` attachment and rejects a non-six-digit passphrase

Proven by `tests/integration/backup-export.test.ts`; container framing by `tests/unit/backup-container.test.ts`.

### Streamed multipart restore

- a valid v2 `.ldb` multipart upload restores and the live DB reflects it
- an upload crossing the byte limit is rejected with HTTP **413**, both from `Content-Length` and during streaming when it is absent, leaving no temp files
- an aborted/cancelled upload leaves no temp files
- checksum mismatch, non-gzip, non-SQLite, and wrong passphrase are rejected without touching live state
- the legacy v1 JSON restore body still works
- the effective maximum upload size is exposed by `GET /api/admin/backup/capabilities`

Proven by `tests/integration/backup-restore-upload.test.ts`. Client progress/cancel behavior by `tests/unit/backup-upload.test.ts` (progress mapping, AbortError + `xhr.abort()`, no manual Content-Type).

### Aggregate statistics and the percentile limitation

- aggregate-only history returns exact totals and averages with unavailable/null percentiles
- a range partially overlapping a compacted day is rejected with 400 rather than silently omitting statistics
- a full aggregate day and a raw day merge once in totals, series, and model rankings
- every date preset (Today, 7 days, 30 days) still answers after a day's raw detail is pruned: a day is
  served from its aggregate only when its raw rows are actually gone, and preset windows are UTC-day
  aligned so the day they start on is whole rather than clipped

Proven by `tests/integration/statistics-fix.test.ts`; the one-time backfill by `tests/integration/daily-aggregate-migration.test.ts` and `tests/unit/daily-aggregate-upsert.test.ts`.

**Documented limitation:** after a compact restore, historical p95 latency and p95 TTFT are unavailable (`percentilesAvailable: false`, `p95LatencyMs`/`p95TtftMs` `null`) for aggregate-only days; average latency and average TTFT remain available because the daily aggregates store sum/count. This limitation is stated in `docs/07-SECURITY-ADMIN-AND-BACKUP.md`, `docs/11-CACHING.md`, and `README.md`, and is asserted by `tests/unit/backup-docs.test.ts`.

## Packaging acceptance

Provider removal acceptance includes: fresh schema accepts only OpenAI/Anthropic provider types, unsupported create/update requests return HTTP 400, retired account/import API routes are absent, and npm build output cannot retain deleted modules. Upgrading an older database removes unsupported provider/model/credential configuration, preserves valid combo priority, restricted ACLs, request/attempt/audit history and daily aggregates, and rejects future or invalid backups before live replacement.

The following must succeed from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

Docker:

```bash
docker build -t latedev-router:test .
docker compose config
docker compose up -d
```

Then `/health` must become healthy and the admin UI must load.

## UX acceptance

- no raw browser alert/confirm for core flows
- all destructive actions are confirmed
- forms show validation errors
- tables handle loading/empty/error states
- dark mode is readable
- primary `#d2004b` is visible but not overused
- request errors and fallback attempts are understandable without reading server logs
- secrets are never re-rendered after their one-time creation/setup step

## Completion report

When implementation is complete, the agent should produce a concise final report containing:

- architecture used
- major features implemented
- commands to run with npm
- commands to run with Docker Compose
- default URL/port
- required environment variables
- test commands and final status
- any genuinely unavoidable limitation

Do not claim completion while a required acceptance criterion is known to be failing.

Read next: `11-CACHING.md`.
