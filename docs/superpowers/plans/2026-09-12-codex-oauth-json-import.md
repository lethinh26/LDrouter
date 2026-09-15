# Native Codex OAuth JSON Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native Codex OAuth account storage, JSON import/preview, token refresh, Codex routing, and admin UI to LDrouter without the external importer folder.

**Architecture:** Add a dedicated `codex_accounts` credential pool linked to a `codex` provider. Keep the existing provider API-key path unchanged for OpenAI/Anthropic, and introduce a Codex-specific adapter that selects, refreshes, and persists account credentials before calling the existing canonical gateway pipeline. Add authenticated preview/import routes and a shadcn-based provider UI; never expose plaintext tokens outside the narrow upstream call boundary.

**Tech Stack:** TypeScript strict, Fastify 5, Drizzle ORM, SQLite WAL/migrations, React/Vite, shadcn/ui, Zod, Vitest, mocked upstream integration tests, existing AES-256-GCM master-key utilities.

**Spec:** `docs/superpowers/specs/2026-09-12-codex-oauth-json-import-design.md`

## Global Constraints

- Runtime is Node.js >= 22 and package manager is pnpm.
- Preserve the single-process Fastify + React/Vite + SQLite architecture.
- Every schema change uses a migration and remains compatible with empty-database startup.
- Existing `openai` and `anthropic` API-key providers must retain current behavior.
- Never log, return, render, or audit raw access, refresh, or ID tokens.
- Codex OAuth accounts are encrypted at rest with the existing master-key mechanism.
- Email alone must never deduplicate Codex accounts when account/workspace identity is missing.
- Streaming fallback is allowed only before semantically committed client output.
- No direct SQLite mutation from an external importer and no Codex CLI config-file writes.
- Do not remove or modify `import-codex-cleaned/`.
- Bump `package.json` minor version and add a top `CHANGELOG.md` entry when the feature is complete; do not commit unless explicitly requested.

---

### Task 1: Map current schema, migrations, routing, and test seams

**Files:**
- Read: `src/server/db/schema.ts`
- Read: `src/server/db/index.ts`
- Read: `src/server/db/migrate.ts`
- Read: `src/server/gateway/runner.ts`
- Read: `src/server/routing/resolver.ts`
- Read: `src/server/routes/admin/providers.ts`
- Read: `src/web/app/pages/providers.tsx`
- Read: `tests/` and existing migration files
- No production file changes.

**Interfaces:**
- Produces the exact migration numbering, database initialization seam, provider-type union locations, candidate/attempt types, and test helpers needed by later tasks.

- [ ] Run `git status --short`, inspect recent commits, and preserve existing user changes.
- [ ] Run GitNexus index/status and query the provider, routing, and admin-provider execution flows; record impacted symbols before editing them.
- [ ] Locate migration registration and empty-database test fixtures.
- [ ] Locate `GatewayRunner` candidate selection and attempt persistence paths.
- [ ] Locate the existing admin provider page route structure and API helper.
- [ ] Run the narrow existing provider/routing tests as a baseline.

**Verification:** Record exact file/symbol names and baseline test command/output before modifying any symbol.

---

### Task 2: Add Codex schema and migration

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/index.ts` only if schema exports/relations require it
- Create: the next migration file under the repository's existing migration directory
- Test: existing migration test plus `tests/integration/codex-schema.test.ts`

**Interfaces:**
- Produces `schema.codexAccounts`, `CodexAccount`, and nullable `requestAttempts.codexAccountId`.
- Provider type accepts `codex`.

- [ ] Write a failing migration/schema test that creates an empty database and asserts `codex_accounts`, required indexes, and `request_attempts.codex_account_id` exist.
- [ ] Run the focused test and verify it fails because the table/column is absent.
- [ ] Add the `codexAccounts` Drizzle table with encrypted token fields, metadata, health, priority, timestamps, provider foreign key, and indexes from the spec.
- [ ] Extend the provider enum/type to include `codex` without changing OpenAI/Anthropic defaults.
- [ ] Add nullable `codexAccountId` to `requestAttempts` and its index/foreign key policy.
- [ ] Generate/write the next migration using the repository's established migration convention; do not hand-edit unrelated migrations.
- [ ] Run the focused migration test and then the existing migration suite.
- [ ] Run typecheck against the schema changes.

**Verification:** Empty database migrates successfully and existing database schema tests remain green.

---

### Task 3: Implement pure Codex import normalizer

**Files:**
- Create: `src/server/providers/codex-import.ts`
- Test: `tests/unit/codex-import.test.ts`
- Create: sanitized fixtures under `tests/fixtures/codex/`

**Interfaces:**
- Produces pure functions with explicit types, including:
  - `parseCodexImportText(text: string, source?: string): NormalizedCodexRecord[] | ParseFailure[]`
  - `normalizeCodexRecord(input: unknown, index: number): NormalizedCodexRecord | ParseFailure`
  - `toCodexPreview(record: NormalizedCodexRecord, duplicateOf?: string | null): CodexPreviewRecord`
- `NormalizedCodexRecord` is internal and contains secrets only for the server-side import pipeline.
- Preview DTO types contain no secret fields.

- [ ] Add sanitized fixture cases for flat JSON, `{tokens}`, `{accounts}`, arrays, JSONL, BOM, whitespace, malformed input, and missing tokens.
- [ ] Write failing unit tests for every accepted shape and failure category.
- [ ] Run the focused tests and verify the missing parser/normalizer failures.
- [ ] Implement BOM/token cleanup, root-shape expansion, JSONL parsing, and bounded input validation.
- [ ] Implement JWT payload decoding without signature verification and metadata precedence for email, account/workspace ID, plan, and expiry.
- [ ] Implement explicit/JWT/relative/fallback expiry resolution with injectable `now` for deterministic tests.
- [ ] Implement safe masking helpers for account/workspace IDs and preview/result DTO construction.
- [ ] Add tests proving `JSON.stringify(preview)` and `JSON.stringify(result)` cannot contain any raw token fixture.
- [ ] Run the focused unit suite, lint, and typecheck.

**Verification:** All parser fixtures pass, malformed records are isolated by index, and no public DTO can contain token fields.

---

### Task 4: Add encrypted Codex account repository and dedupe/upsert logic

**Files:**
- Create: `src/server/db/repositories/codex-accounts.ts`
- Modify: `src/server/auth/crypto.ts` only if a small null-encryption helper is required
- Test: `tests/unit/codex-accounts-repository.test.ts`
- Test: `tests/integration/codex-accounts.test.ts`

**Interfaces:**
- Produces safe summary and credential access types:
  - `listCodexAccountSummaries(providerId: string)`
  - `findCodexAccountForImport(providerId: string, identity: CodexIdentity)`
  - `insertCodexAccount(providerId: string, record: NormalizedCodexRecord)`
  - `updateCodexAccountFromImport(id: string, record: NormalizedCodexRecord)`
  - `getCodexCredentials(id: string): DecryptedCodexCredentials`
  - `setCodexAccountHealth(...)`
- Plaintext credentials are returned only by `getCodexCredentials` to the provider adapter.

- [ ] Write failing tests for new account insert, encrypted-at-rest storage, preserving ID/createdAt on update, and safe summaries.
- [ ] Write failing tests for same account/workspace update, same email/different workspace separation, and email-only non-merge.
- [ ] Implement identity resolution in the exact priority order from the spec.
- [ ] Implement encryption of access/refresh/optional ID tokens with independent nonces and stored versions.
- [ ] Implement transaction-safe insert/update with priority assignment under the provider.
- [ ] Implement masked summary projection and ensure repository list functions never select/decrypt token columns unnecessarily.
- [ ] Implement soft-disable semantics for referenced accounts.
- [ ] Run focused unit/integration tests and inspect the database directly through safe non-secret assertions.
- [ ] Run GitNexus impact analysis before modifying any existing repository symbol and record the result.

**Verification:** Database contains ciphertext, re-import preserves stable identity, and account summaries contain no secret values.

---

### Task 5: Add Codex admin API preview/import/account management

**Files:**
- Create: `src/server/routes/admin/codex.ts`
- Modify: `src/server/routes/admin.ts`
- Modify: `src/server/app.ts` only if multipart/request-size registration is required
- Test: `tests/integration/admin-codex-import.test.ts`

**Interfaces:**
- Adds:
  - `POST /api/admin/codex/accounts/preview`
  - `POST /api/admin/codex/accounts/import`
  - `GET /api/admin/codex/accounts`
  - `PATCH /api/admin/codex/accounts/:id`
  - `DELETE /api/admin/codex/accounts/:id`
  - `POST /api/admin/codex/accounts/:id/test`
- All routes use existing admin auth and CSRF conventions.

- [ ] Write failing integration tests for unauthenticated rejection, preview non-mutation, valid import, partial failure, and redacted responses.
- [ ] Add Zod schemas for JSON body, selected indexes, account updates, and bounded record/batch sizes.
- [ ] Implement request parsing for JSON text and multiple JSON file parts using existing multipart support; keep ZIP out of this task.
- [ ] Implement preview by normalizing and checking existing identity without writing or calling upstream.
- [ ] Implement import by re-parsing server-side, applying selected indexes, upserting each valid record, and returning safe per-record statuses.
- [ ] Add sanitized audit events for preview/import/update/disable/test operations.
- [ ] Implement list/update/soft-delete routes using safe summaries only.
- [ ] Add the Codex provider guard so these routes cannot attach accounts to a non-Codex provider.
- [ ] Run focused integration tests, lint, and typecheck.

**Verification:** Admin API works only with admin auth, preview does not mutate, import persists encrypted records, and every response/log/audit assertion is secret-free.

---

### Task 6: Implement Codex credential refresh lifecycle

**Files:**
- Create: `src/server/providers/codex-refresh.ts`
- Modify: `src/server/db/repositories/codex-accounts.ts`
- Test: `tests/unit/codex-refresh.test.ts`
- Test: `tests/integration/codex-refresh.test.ts`

**Interfaces:**
- Produces:
  - `needsCodexRefresh(account, now): boolean`
  - `refreshCodexAccount(accountId): Promise<SafeRefreshResult>`
  - `withCodexCredentials(accountId, fn): Promise<T>`
- Refresh result must preserve omitted existing fields and persist rotated refresh tokens.

- [ ] Write failing tests for expiry lead time, refresh response with rotated refresh token, response omitting ID token, and refresh failure.
- [ ] Write a concurrency test proving two simultaneous refreshes for one account result in one upstream refresh request.
- [ ] Implement an in-process single-flight map keyed by account ID with cleanup after resolve/reject.
- [ ] Implement Codex refresh request payload and bounded timeout using native fetch/AbortController.
- [ ] Persist access token, optional rotated refresh token, optional ID token, expiry, and last refresh atomically.
- [ ] Sanitize refresh errors and update account health/error fields without logging credential values.
- [ ] Run focused tests and the secret-redaction suite.

**Verification:** Rotation is persisted, concurrent refresh is single-flight, and failed refreshes fail closed without destroying old credentials.

---

### Task 7: Implement Codex upstream adapter and model discovery

**Files:**
- Create: `src/server/providers/codex.ts`
- Modify: `src/server/providers/index.ts`
- Modify: `src/server/upstream/client.ts` only where shared interfaces must accept `codex`
- Modify: `src/server/routes/admin/providers.ts` for Codex-specific test/discovery dispatch
- Test: `tests/unit/codex-provider.test.ts`
- Test: `tests/integration/codex-upstream.test.ts`

**Interfaces:**
- Produces Codex-specific functions for provider probe, model discovery, request URL/headers, canonical payload preparation, credential selection, and safe outcome metadata.
- Existing generic OpenAI/Anthropic functions retain their current signatures/behavior.

- [ ] Write failing mocked-upstream tests for model discovery, required Codex headers, non-streaming success, streaming success, and unsupported response fields.
- [ ] Write a failing test for 401/403 refresh-and-retry exactly once.
- [ ] Implement Codex provider configuration and model discovery endpoint handling based on the verified upstream contract.
- [ ] Implement account selection with enabled/health/expiry/capability filtering.
- [ ] Implement credential acquisition through the refresh lifecycle, never through provider API-key decryption.
- [ ] Implement Codex request mapping from the canonical request and response/event mapping back to the gateway's existing protocol adapters.
- [ ] Preserve streaming and abort/timeout behavior; do not buffer the full response.
- [ ] Add safe handling for upstream errors and request IDs.
- [ ] Wire admin provider test/discovery dispatch for `type === 'codex'`.
- [ ] Run focused unit/integration tests and verify existing OpenAI/Anthropic provider tests remain green.
- [ ] Run GitNexus impact analysis before modifying provider/upstream symbols and inspect the affected execution flows.

**Verification:** Mock Codex requests succeed for streaming and non-streaming paths, refresh retry is bounded, and existing providers regress neither typecheck nor tests.

---

### Task 8: Integrate Codex accounts with routing and attempt logging

**Files:**
- Modify: `src/server/gateway/runner.ts`
- Modify: `src/server/routing/resolver.ts`
- Modify: `src/server/routing/combo.ts` if account selection belongs there
- Modify: `src/server/db/repositories/` request persistence module(s)
- Test: `tests/unit/codex-routing.test.ts`
- Test: `tests/integration/codex-routing.test.ts`

**Interfaces:**
- Candidate/attempt state includes optional `codexAccountId` and safe selection reason.
- Existing physical-model/combo routing APIs remain compatible for non-Codex providers.

- [ ] Write failing tests for account fallback before stream commitment, no fallback after committed stream data, unhealthy-account filtering, and weighted distribution.
- [ ] Write failing tests asserting request attempts persist account IDs but never credentials.
- [ ] Implement account candidate expansion after a Codex physical model is selected.
- [ ] Reuse existing retry/fallback policy and global attempt cap; do not multiply provider retries with account retries.
- [ ] Add account health/circuit updates only for upstream-health failures.
- [ ] Add account ID to attempt persistence and safe request detail responses.
- [ ] Ensure direct non-Codex physical model requests remain unchanged.
- [ ] Run focused routing/integration tests and all existing routing tests.
- [ ] Run GitNexus impact analysis before editing runner/resolver symbols and warn on HIGH/CRITICAL impact before proceeding.

**Verification:** Account fallback, weighted selection, capability filtering, stream commitment invariant, and attempt logging are all tested.

---

### Task 9: Add Codex account management and import UI

**Files:**
- Modify: `src/web/app/pages/providers.tsx` or the existing provider-detail component if the page is split during inspection
- Create: `src/web/components/codex-import-dialog.tsx` if the dialog is large enough to warrant isolation
- Modify: `src/web/lib/api.ts` only if typed multipart support is required
- Test: `tests/e2e/codex-import.spec.ts` or the repository's established Playwright location

**Interfaces:**
- UI consumes the preview/import/account API contracts from Task 5.
- UI shows safe account summaries and never handles token values after upload submission.

- [ ] Add a failing component/E2E assertion for Codex-only account panel visibility and import controls.
- [ ] Add Codex provider account table with email, masked identity, plan, expiry, health, enabled, and last refresh.
- [ ] Add shadcn dialog with multi-file JSON selection, paste area, preview state, valid/invalid/duplicate results, selection controls, and import action.
- [ ] Add loading, field-level error, mutation toast, empty-state, and partial-failure states.
- [ ] Add enable/disable/test/soft-delete actions with confirmation where destructive.
- [ ] Ensure the UI never renders raw input JSON after upload and never renders token fields from API responses.
- [ ] Add E2E coverage for preview then import using a test fixture and mocked admin API/upstream.
- [ ] Run frontend lint, typecheck, build, and the focused E2E flow.

**Verification:** The admin can import multiple JSON records through the UI, review safe preview data, and see persisted account summaries without secrets.

---

### Task 10: Add documentation, version bump, and release verification

**Files:**
- Modify: `README.md`
- Modify: relevant operator docs under `docs/`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Test: package/build/Docker acceptance commands

**Interfaces:**
- Documents provider creation, Codex account import formats, security limitations, refresh behavior, and the absence of Codex CLI config-file mutation.

- [ ] Document the Codex setup flow and supported JSON formats with redacted examples.
- [ ] Document account identity/dedup behavior, master-key requirements, and token privacy guarantees.
- [ ] Document that ZIP and CLI config auto-generation are not included in the first release.
- [ ] Bump `package.json` from the current version using a minor release increment.
- [ ] Add a top `CHANGELOG.md` entry with the feature summary.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `npm pack --dry-run` and verify migrations and bundled web assets are included.
- [ ] Run `docker build -t latedev-router:test .`.
- [ ] Run `docker compose config`.
- [ ] Run GitNexus `detect_changes()` and compare the affected symbols/flows against the expected Codex feature scope.

**Verification:** All acceptance commands pass, package contents include the new migration/runtime assets, Docker configuration remains valid, and the final diff excludes `import-codex-cleaned/` changes.

---

## Self-review checklist

- [x] Spec coverage: schema, normalization, encryption, API, UI, refresh, routing, testing, backup, and rollout are represented.
- [x] No placeholder words such as `TBD`, `TODO`, or `implement later` are used as implementation steps.
- [x] Later tasks consume interfaces named by earlier tasks.
- [x] Existing OpenAI/Anthropic behavior is explicitly protected.
- [x] Secret handling is repeated at schema, repository, API, UI, logging, and testing boundaries.
- [x] Version bump and changelog requirements are included.
- [x] User-owned working-tree changes and the temporary importer folder are explicitly preserved.

## Execution handoff

Implement task-by-task with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Before editing any existing symbol, run the required GitNexus impact analysis and report HIGH/CRITICAL risk before proceeding. After meaningful architectural changes, re-index GitNexus and run `detect_changes()` before any commit.
