# LateDev Router Upgrade Roadmap Design

## Status

Approved scope: implement all roadmap milestones in sequence.

## Product outcome

LateDev Router becomes easier to debug, safer to operate, and more predictable under routing failures, retention cleanup, caching, admin security changes, and Docker deployment failures.

## Milestone order

### M1 — Request debugging UX and retention operations

- Split request detail into Overview, Attempts, Request, Response, and Replay tabs.
- Lazy-render only the active large-content panel.
- Add copy/download actions and bounded preview for large JSON.
- Show attempt timeline, fallback reason, status, latency, TTFT, and stream-start state.
- Add retention preview and manual cleanup with confirmation.
- Preserve UTC-day semantics, daily aggregates, audit logs, and today's request detail.

### M2 — Routing explainability and provider health

- Persist or derive sanitized routing decision reason codes.
- Show candidate filtering and selected candidate in request detail.
- Add provider health summaries and circuit state to Providers.
- Add combo eligibility and fallback distribution summaries.
- Keep reason codes non-sensitive and avoid logging credentials or raw payloads.

### M3 — Gateway response cache

- Add SQLite response-cache migration and repository.
- Cache only successful non-streaming responses by default.
- Keep global cache disabled by default.
- Use canonical request-affecting fields and a cryptographic cache key.
- Add TTL, max-size eviction, manual clear, target/key policy, and revision invalidation.
- Exclude cache from compact backups and retain it in full backups.
- Record cache hits separately from provider prompt-cache tokens.

### M4 — Admin security hardening

- Add active-session listing/revocation.
- Add login failure backoff/lockout with audit events.
- Tighten TOTP enable/disable/recovery flows.
- Improve backup and restore warnings and safety checks.
- Cover CSRF, session expiry, secret redaction, and restore rollback over HTTP.

### M5 — Deployment reliability

- Add manual deploy by previously published image tag.
- Add explicit rollback workflow/path.
- Verify image reference, OCI revision, app version, health, and readiness.
- Keep compose override cleanup and rollback atomic.
- Document VPS prerequisites and recovery commands.

## Non-goals

- No Redis, PostgreSQL, Kafka, or Kubernetes.
- No multi-user/RBAC.
- No monetary cost tracking.
- No streaming response cache.
- No default tool-call response cache.
- No automatic deletion of audit logs.
- No unrelated provider integrations.

## Data and privacy rules

- Existing request retention remains UTC-day based.
- Daily aggregates are preserved when raw request detail is pruned.
- Cache is sensitive application data and is disabled by default.
- Secrets must not appear in logs, normal errors, cache keys, backups, or admin responses.
- Destructive operations require confirmation and audit events.

## Compatibility

- Preserve OpenAI-compatible and Anthropic-compatible gateway contracts.
- Preserve streaming behavior and fallback-before-first-byte semantics.
- Existing SQLite databases must migrate forward without data loss.
- Existing compact/full backup semantics remain valid.
- Docker deployment remains single-process with persistent `/data`.

## Verification contract

Each milestone must pass its focused unit/integration/E2E tests before the next milestone starts. The final gate is:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
docker compose config
docker build -t latedev-router:test .
```

Additional required evidence:

- Request detail handles very large payloads without page overflow.
- Retention cleanup deletes only eligible complete UTC days.
- Routing reasons match actual candidate filtering.
- Cache hit produces zero upstream attempts and remains off by default.
- Security mutations enforce authentication, CSRF, and redaction.
- VPS deployment runs the requested image revision and rollback is functional.

## Implementation policy

- Inspect and impact-analyze shared symbols before edits.
- Use migrations for schema changes.
- Add a regression test for each behavior change.
- Keep each milestone separately reviewable and reversible.
- Do not weaken existing gates to make a milestone pass.
