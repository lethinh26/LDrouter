# LateDev Router Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Nâng cấp LateDev Router theo spec đã duyệt, ưu tiên khả năng debug, vận hành, routing explainability, cache an toàn, bảo mật admin và deploy reliability.

**Architecture:** Giữ Node/Fastify/SQLite/React hiện tại. Mỗi milestone thay đổi một boundary rõ ràng, dùng migration cho schema, bổ sung test trước khi sửa production path, rồi chạy gate trước khi chuyển milestone tiếp theo.

**Tech Stack:** TypeScript strict, Fastify, SQLite, Drizzle/native query layer hiện tại, React/Vite, shadcn/ui, Tailwind, Vitest, Playwright, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-22-latedev-router-upgrade-design.md`

## Global Constraints

- Không thêm Redis, PostgreSQL, Kafka, Kubernetes hoặc dependency thay thế tương đương.
- Giữ nguyên OpenAI-compatible/Anthropic-compatible APIs và streaming semantics.
- Cache gateway mặc định tắt; không cache streaming/tool-call mặc định.
- Retention dùng complete UTC days; giữ daily aggregates và audit logs.
- Không ghi secrets vào logs, errors, cache keys, backups hoặc admin responses.
- Mọi schema change dùng migration.
- Không commit secret và không làm yếu gate hiện tại.

---

## Task 1: Baseline and code-graph impact

**Files:**
- Read: `src/web/app/pages/requests.tsx`, `src/server/maintenance/retention.ts`, `src/server/routes/admin/requests.ts`, `src/server/routes/admin/settings.ts`
- Read: `src/server/gateway/runner.ts`, `src/server/routing/resolver.ts`, `src/server/routing/circuit.ts`, `src/server/metrics/registry.ts`
- Read: `src/server/db/schema.ts`, `src/server/db/migrate.ts`, `src/server/backup/export.ts`, `src/server/backup/restore-upload.ts`
- Test: existing focused suites under `tests/unit` and `tests/integration`

**Interfaces:**
- Produces a verified list of symbols and callers before each shared-file edit.

- [ ] Confirm clean status and current branch.
- [ ] Run GitNexus impact analysis for each shared symbol before editing it.
- [ ] Record the current focused test commands and baseline output.
- [ ] Stop and report if baseline gates are red for unrelated reasons.

## Task 2: M1 request detail lazy rendering and actions

**Files:**
- Modify: `src/web/app/pages/requests.tsx`
- Read/Reuse: `src/web/components/ui/tabs.tsx`, `src/web/components/ui/scroll-area.tsx`, existing Button/Dialog components
- Test: existing request page tests or add `tests/unit/request-detail.test.tsx` only if a test seam exists

**Interfaces:**
- Consumes current request detail API payload.
- Produces tabbed detail UI that renders only the active payload section.

- [ ] Add a failing test or deterministic component assertion for active-tab-only rendering and long-payload wrapping.
- [ ] Implement Overview/Attempts/Request/Response/Replay tabs.
- [ ] Add copy JSON, download JSON, and request-ID copy actions without storing secrets.
- [ ] Add bounded preview for large payloads with explicit full-content action.
- [ ] Run focused frontend tests and typecheck.

## Task 3: M1 retention operations UI/API

**Files:**
- Modify: `src/server/maintenance/retention.ts`
- Modify: `src/server/routes/admin/settings.ts`
- Modify: `src/web/app/pages/settings.tsx`
- Test: `tests/unit/retention.test.ts`
- Test: relevant admin settings integration suite

**Interfaces:**
- Reuse the existing daily cleanup function and return a preview/result with request and attempt counts plus UTC boundary.
- Manual cleanup must be authenticated, CSRF-protected, audited, and preserve aggregates/audit rows.

- [ ] Add failing tests for preview non-mutation and manual cleanup boundary.
- [ ] Implement bounded preview and manual cleanup route using existing retention helper.
- [ ] Add confirmation UI showing rows/date range and preservation notice.
- [ ] Add success/error feedback and refresh state.
- [ ] Run retention and admin integration tests.

## Task 4: M1 regression gate

**Files:**
- Modify: `tests/integration` only if coverage is missing.

- [ ] Verify request detail with very large request/response payloads.
- [ ] Verify request detail attempts remain ordered and fallback reasons are visible.
- [ ] Verify retention deletes only complete UTC days and keeps today's rows, aggregates, and audit logs.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Task 5: M2 routing reason codes and explainability

**Files:**
- Modify: `src/server/routing/resolver.ts`
- Modify: `src/server/gateway/runner.ts`
- Modify: `src/server/routes/admin/requests.ts`
- Modify: request/attempt schema and migration only if current payload cannot represent reasons
- Test: routing and gateway integration suites

**Interfaces:**
- Produces sanitized candidate decisions with stable reason codes: `disabled`, `upstream_unavailable`, `capability_mismatch`, `circuit_open`, `api_key_not_allowed`, `timeout`, `http_429`, and selected/attempted states.

- [ ] Add failing integration tests for capability mismatch, circuit-open filtering, and fallback selection reasons.
- [ ] Implement reason collection at the real gateway boundary, not only in helpers.
- [ ] Expose reasons in request detail API without secrets or raw payloads.
- [ ] Verify stream-started failures never claim fallback occurred after bytes were sent.

## Task 6: M2 health and combo observability

**Files:**
- Modify: `src/server/metrics/registry.ts`
- Modify: provider/combo admin routes and pages.
- Test: provider health, combo routing, and metrics integration suites.

- [ ] Add failing tests for health summary and circuit state output.
- [ ] Expose provider success/error/latency/TTFT summaries using bounded cardinality.
- [ ] Add provider health and combo eligibility/fallback summaries to the UI.
- [ ] Verify metrics never use request ID, IP, raw API key, or secret as labels.

## Task 7: M2 regression gate

- [ ] Run routing integration tests including fallback-before-first-byte and stream-after-first-byte cases.
- [ ] Run provider/metrics tests.
- [ ] Run full lint/typecheck/test/build gate before cache work.

## Task 8: M3 response-cache migration and repository

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: next numbered SQL migration under `migrations/`
- Modify/Create: `src/server/caching/store.ts`
- Test: `tests/unit` cache-key/store tests

**Interfaces:**
- `response_cache` stores hashed key, target revision, response payload, usage metadata, created/expiry/last-hit timestamps, hit count, and stored bytes.
- Cache repository supports get, put, touch-hit, clear, TTL cleanup, and bounded size eviction.

- [ ] Add failing unit tests for canonical exact-key behavior, TTL, clear, and size eviction.
- [ ] Add migration without modifying existing migration history.
- [ ] Implement repository using existing SQLite access and chunked cleanup.
- [ ] Verify cache key never contains raw secrets.

## Task 9: M3 gateway cache integration and policy

**Files:**
- Modify: `src/server/gateway/runner.ts`
- Modify: settings repository/routes/page.
- Modify: statistics/request detail mapping.
- Test: gateway cache integration suite.

- [ ] Add failing tests for disabled-by-default, successful non-stream hit, streaming bypass, tool-call bypass, TTL miss, and zero upstream attempts on hit.
- [ ] Implement secure policy precedence: global OFF, explicit key OFF, explicit target OFF, otherwise explicit allow on both sides.
- [ ] Add alias/combo revision invalidation.
- [ ] Record gateway cache hit separately from provider prompt-cache tokens.

## Task 10: M3 backup/statistics regression gate

- [ ] Verify compact backup excludes response cache and full backup retains it.
- [ ] Verify cache hit rate appears separately from provider cache token counts.
- [ ] Run backup, statistics, cache integration, lint, typecheck, test, and build gates.

## Task 11: M4 admin security hardening

**Files:**
- Modify: `src/server/auth/middleware.ts`, `src/server/auth/recovery.ts`
- Modify: `src/server/routes/admin/auth.ts`, `src/server/routes/admin/settings.ts`
- Modify: `src/web/app/pages/settings.tsx`
- Test: authenticated admin HTTP integration tests

- [ ] Add failing tests for session revocation, failed-login backoff, CSRF, TOTP disable requirements, and secret redaction.
- [ ] Implement active-session list/revoke/revoke-all.
- [ ] Implement bounded login failure backoff with audit event and no secret logging.
- [ ] Harden TOTP/recovery and backup warning flows.
- [ ] Verify destructive actions require fresh confirmation.

## Task 12: M4 security regression gate

- [ ] Run admin auth/settings/backup integration tests over HTTP.
- [ ] Scan logs, errors, database/API responses for secrets.
- [ ] Run full lint/typecheck/test/build gate.

## Task 13: M5 deployment reliability

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `Dockerfile`, `docker-compose.yml` only if required for OCI revision/version verification.
- Modify: `docs/09-OPERATIONS-NPM-DOCKER.md` and `README.md`.

- [ ] Add manual `image_tag` deploy path without rebuilding.
- [ ] Add explicit rollback path and verify image revision, app version, health, and readiness.
- [ ] Preserve cleanup of temporary compose override files.
- [ ] Document VPS prerequisites and recovery commands without credentials.
- [ ] Validate YAML, shell fragments, Docker compose config, and workflow syntax.

## Task 14: Final acceptance and release

- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `npm pack --dry-run`.
- [ ] Run `docker compose config`.
- [ ] Build Docker image when local daemon is available.
- [ ] Run GitNexus change detection against `main`.
- [ ] Review diff for secrets and unrelated files.
- [ ] Commit each milestone separately; tag/release only after all gates pass and user confirms release scope.
