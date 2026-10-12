# Compact Backup and Streaming Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compact/full SQLite backups that preserve daily operational statistics and stream large restore uploads with visible progress.

**Architecture:** Add durable daily aggregate tables updated atomically alongside raw request/attempt persistence. Compact export snapshots into a pruned SQLite staging DB and packages it in a v2 binary container; full export preserves all rows. Multipart restore streams to a private file, validates from disk, and reuses the existing atomic replacement/rollback path. The UI uses XHR solely where upload-progress events are needed.

**Tech Stack:** Node.js 22 streams, TypeScript strict, Fastify 5 + existing `@fastify/multipart`, better-sqlite3, Drizzle, React 19, shadcn/ui, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-compact-backup-and-streaming-restore-design.md`

## Global Constraints

- Keep one application process and one SQLite WAL database; add no runtime dependency.
- Use strict TDD: one failing behavior test, observe RED, minimal implementation, observe GREEN, then refactor.
- Preserve `LATEDEV_MASTER_KEY` behavior and never log or expose a passphrase, master key, credentials, API keys, request payloads, response payloads, or upload body.
- New export defaults to `compact`; full forensic export is explicit.
- Preserve legacy `.ldb.json` restore compatibility; new backups are binary `.ldb`.
- Never overwrite the live DB before checksum, master-key envelope, SQLite integrity, and schema compatibility validation succeed.
- Do not commit, push, tag, or modify existing unrelated `AGENTS.md` / `CLAUDE.md` changes without explicit user instruction.

## File map

- Create: `src/server/backup/container.ts` — v2 header serialization/parsing, checksum-aware payload boundaries, legacy envelope types.
- Create: `src/server/backup/export.ts` — snapshot/staging/profile pruning/compression streaming.
- Create: `src/server/backup/restore-upload.ts` — multipart-to-disk collection, temporary lifecycle, disk validation.
- Create: `src/server/backup/stats.ts` — aggregate upserts, backfill, aggregate query helpers.
- Modify: `src/server/db/schema.ts` — aggregate table definitions/types.
- Modify: `src/server/db/migrate.ts` and add a numbered SQL migration — persistent aggregate tables/indexes and one-time backfill marker.
- Modify: `src/server/gateway/runner.ts` — transactionally write raw rows and aggregate deltas.
- Modify: `src/server/routes/admin/stats.ts` — source-partitioned history queries and percentile availability.
- Modify: `src/server/routes/admin/dashboard.ts` — aggregate fallback for current totals only where raw data is absent.
- Modify: `src/server/routes/admin/backup.ts` — thin route adapters using backup modules; multipart restore and legacy JSON compatibility.
- Modify: `src/server/app.ts` — existing multipart limits/cleanup bootstrap only if current registration lacks a safe per-route configuration seam.
- Modify: `src/web/app/pages/settings.tsx` and `src/web/app/pages/setup.tsx` — profile selector and shared progress restore UI.
- Create: `src/web/lib/backup-upload.ts` — XHR upload/progress/cancel helper.
- Modify: `src/shared/types.ts` — only response fields shared with UI, including nullable percentile availability/profile result.
- Modify: `docs/07-SECURITY-ADMIN-AND-BACKUP.md`, `docs/11-CACHING.md`, `docs/10-TESTING-AND-ACCEPTANCE.md`, `README.md` — authoritative behavior/operator instructions.
- Create/modify existing test locations after locating the actual Vitest convention; no test folder is currently discoverable under `src`, so inspect `vitest.config.*` and repository roots first.

### Task 1: Establish test harness and backup contracts

**Files:**
- Create: `src/server/backup/container.ts`
- Create: appropriate existing-or-new Vitest test file discovered from `vitest.config.*`
- Modify: `src/server/routes/admin/backup.ts`

**Interfaces:**
- Produces `BackupProfile = 'compact' | 'full'`.
- Produces `BackupManifestV2`, `writeBackupContainer()`, `readBackupContainerHeader()`, `streamBackupPayload()`.
- Consumes existing `BackupMasterKeyEnvelope` from `src/server/auth/backup-crypto.ts`.

- [ ] **Step 1: Locate the Vitest configuration and nearest route/integration test convention**

Run:
```bash
find . -maxdepth 3 \( -name 'vitest.config.*' -o -name '*backup*.test.ts' -o -path '*test*' \) -print
git status --short
```
Expected: identify the real test root without reading `.env` files; record unrelated modified instruction files and leave them untouched.

- [ ] **Step 2: Write a failing v2 container round-trip test**

```ts
it('writes a compact manifest and streams exactly the compressed payload bytes', async () => {
  const payload = Buffer.from('sqlite bytes');
  const out = await writeBackupContainer({ manifest: compactManifest, payload: Readable.from(payload) });
  const { manifest, payloadStream } = await readBackupContainerHeader(out);
  expect(manifest.profile).toBe('compact');
  await expect(readAll(payloadStream)).resolves.toEqual(payload);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run the discovered Vitest command for the new file.
Expected: failure because the v2 container module/export does not exist.

- [ ] **Step 4: Implement the fixed-prefix, length-prefixed manifest and bounded streaming reader**

```ts
export const BACKUP_MAGIC = Buffer.from('LDRB');
export const BACKUP_VERSION = 2;

export async function writeBackupContainer(input: { manifest: BackupManifestV2; payload: Readable }): Promise<Readable>;
export async function readBackupContainerHeader(file: string): Promise<{ manifest: BackupManifestV2; payloadOffset: number }>;
```

Use an explicit maximum manifest byte size and reject invalid magic/version/length before allocating arbitrary buffers. Hash only payload bytes, not the header.

- [ ] **Step 5: Run focused test and lint/typecheck**

Run:
```bash
pnpm test -- <focused-file>
pnpm lint
pnpm typecheck
```
Expected: all pass.

### Task 2: Persist daily aggregate statistics safely

**Files:**
- Modify: `src/server/db/schema.ts`
- Add: next numbered SQL migration in `migrations/`
- Modify: `src/server/db/migrate.ts`
- Create: `src/server/backup/stats.ts`
- Modify: `src/server/gateway/runner.ts`
- Test: integration test for request persistence and migration backfill

**Interfaces:**
- Produces `recordDailyStatistics(db, input): void` and `backfillDailyStatistics(raw): void`.
- Produces daily model/provider/API-key aggregate schema tables with unique keys `(day, dimensionId)`.
- Consumes the existing request/attempt outcomes passed into `GatewayRunner` persistence.

- [ ] **Step 1: Write a failing integration test for one request with two attempts**

```ts
it('updates model, provider, and API-key day aggregates with request and attempt outcomes', async () => {
  await persistOutcome(successfulRequestWithFailedThenSuccessfulAttempt);
  expect(readModelDay()).toMatchObject({ requests: 1, failedRequests: 0, fallbackRequests: 1 });
  expect(readProviderDay('first-provider')).toMatchObject({ attempts: 1, failedAttempts: 1 });
  expect(readProviderDay('second-provider')).toMatchObject({ attempts: 1, successfulAttempts: 1 });
});
```

- [ ] **Step 2: Run only that integration test and verify RED**

Expected: aggregate tables/functions do not exist.

- [ ] **Step 3: Add schema/migration and aggregate upserts**

Use integer sum/count columns and SQLite `ON CONFLICT ... DO UPDATE`; update aggregate rows inside the same database transaction used for request persistence. Backfill existing raw logs exactly once using a migration marker; no full-table backfill at process startup.

- [ ] **Step 4: Run aggregate tests and migration-from-populated-DB test**

Add a second test that seeds raw rows, runs the migration, checks aggregate values, then reruns migration and proves no double count.

Run focused tests; expected PASS.

- [ ] **Step 5: Refactor only duplicated aggregation expressions and rerun focused tests**

Keep public behavior unchanged; do not change quota tables or routing semantics.

### Task 3: Read aggregate history without double counting

**Files:**
- Modify: `src/server/backup/stats.ts`
- Modify: `src/server/routes/admin/stats.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/web/app/pages/statistics.tsx` only after inspecting its current response rendering
- Test: statistics integration tests

**Interfaces:**
- Produces `queryStatisticsRange(db, range): StatisticsSourceResult`.
- Returns `percentilesAvailable: boolean`, nullable `p95LatencyMs`, nullable `p95TtftMs`, and existing totals/rankings.

- [ ] **Step 1: Write a failing statistics test for aggregate-only history**

```ts
it('returns exact totals and averages but null percentiles for compacted daily history', async () => {
  seedDailyModelStats({ day: '2026-01-01', requests: 4, latencySuccessSumMs: 400, latencySuccessCount: 2 });
  const result = await adminStats({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T23:59:59Z' });
  expect(result.summary.averageLatencyMs).toBe(200);
  expect(result.summary.p95LatencyMs).toBeNull();
  expect(result.percentilesAvailable).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Expected: endpoint reads only `requests` and lacks the availability field.

- [ ] **Step 3: Implement source partitioning**

For fully closed UTC days with aggregate rows, query aggregates; for partial/current days or ranges without aggregates, query raw rows. Merge series/rankings by stable ID and never sum the same day from both sources. Calculate averages from sum/count; return `null` p95 values if any aggregate-only day participates.

- [ ] **Step 4: Add and run tests for mixed raw+aggregate range and top rankings**

Assert no double count and correct model/provider/API-key rankings. Verify dashboard current-day failure detail remains raw-only.

- [ ] **Step 5: Update UI only for changed semantics**

Show a compact explanatory note when `percentilesAvailable` is false; do not render fake zero percentiles. Run web-focused tests/build if the repo has them.

### Task 4: Build compact/full export without buffering payloads

**Files:**
- Create: `src/server/backup/export.ts`
- Modify: `src/server/routes/admin/backup.ts`
- Test: backup integration tests

**Interfaces:**
- Produces `createBackupExport({ profile, passphrase, cfg }): Promise<{ manifest, body: Readable }>`.
- Consumes `BackupProfile`, live SQLite DB path, master-key envelope helpers, and snapshot APIs.

- [ ] **Step 1: Write a failing compact export test**

```ts
it('creates a compact backup without request, attempt, audit, or cache rows while retaining aggregate stats', async () => {
  await seedBackupFixture({ requests: 2, attempts: 2, audits: 1, cacheEntries: 1, dailyStats: 1 });
  const restored = await openExportedPayload(await createBackupExport({ profile: 'compact', passphrase }));
  expect(count(restored, 'requests')).toBe(0);
  expect(count(restored, 'daily_model_stats')).toBe(1);
});
```

- [ ] **Step 2: Run it and verify RED**

Expected: current export makes a full JSON/base64 envelope.

- [ ] **Step 3: Implement consistent snapshot → staging prune → VACUUM → streamed gzip/container**

Use `better-sqlite3.backup()` for the initial consistent snapshot. For compact, operate only on a copied staging DB, delete excluded table data plus sessions/backups, run `VACUUM`, then pipe gzip to container output. Always remove snapshot/staging files in `finally`. Do not use `readFileSync` for the SQLite payload or `gzipSync` for the complete database.

- [ ] **Step 4: Add full-profile and size-comparison tests**

Assert full preserves raw/audit/cache rows; compact is smaller for a fixture with repetitive log/cache data. Assert manifest profile/excluded tables/checksum are correct.

- [ ] **Step 5: Keep legacy create behavior out of new exports and run focused tests**

New create route returns `application/octet-stream`, attachment `.ldb`; legacy JSON remains restore-only.

### Task 5: Stream uploads to disk and validate before swapping

**Files:**
- Create: `src/server/backup/restore-upload.ts`
- Modify: `src/server/routes/admin/backup.ts`
- Modify: `src/server/app.ts` only if multipart registration must expose limits
- Test: restore integration tests

**Interfaces:**
- Produces `receiveBackupUpload(request, options): Promise<UploadedBackup>` with `path`, `bytes`, `cleanup()`.
- Produces `validateUploadedBackup(upload, passphrase): Promise<ValidatedBackup>`.
- Existing atomic replacement code becomes `restoreValidatedDatabase(validated, req): Promise<RestoreResult>`.

- [ ] **Step 1: Write failing multipart test for streamed destination and size enforcement**

```ts
it('streams multipart restore to a private temp file and rejects a body that crosses the byte limit', async () => {
  const response = await app.inject(multipartRestore({ bytes: maxBytes + 1 }));
  expect(response.statusCode).toBe(413);
  expect(tempDirectoryFiles()).toEqual([]);
});
```

- [ ] **Step 2: Run it and verify RED**

Expected: route treats body as JSON and lacks multipart stream handling.

- [ ] **Step 3: Implement receiver and cancellation cleanup**

Use `req.parts()`/file stream from installed Fastify multipart. Generate destination names with `randomUUID`; write under `dataDir/restore-tmp`, creating directory mode `0700`, files mode `0600`. Enforce byte count during streaming, attach request abort cleanup, reject multiple `backup` parts and unknown oversized file content.

- [ ] **Step 4: Write failing validation/rollback tests**

Cover checksum mismatch, invalid gzip/SQLite, future schema, wrong passphrase, failure after snapshot/swap, and legacy v1 JSON input. Assert live DB content and prior master-key override remain intact after each failure.

- [ ] **Step 5: Implement disk-based validation and extract existing swap code**

Read only v2 header into a bounded buffer; stream payload decompression to a temporary SQLite file with a strict uncompressed byte ceiling; run read-only `PRAGMA integrity_check`; then call extracted atomic restore. Preserve existing first-run auth exception and session recreation. Convert raw filesystem exceptions to safe `GatewayError` responses.

- [ ] **Step 6: Run all backup/restore integration tests**

Expected: compact/full/legacy success plus all validation/rollback cases pass; all temp files are gone after success, failure, and aborted request.

### Task 6: Add progress/cancel UI for Settings and first-run Setup

**Files:**
- Create: `src/web/lib/backup-upload.ts`
- Modify: `src/web/app/pages/settings.tsx`
- Modify: `src/web/app/pages/setup.tsx`
- Test: UI/unit or E2E tests according to discovered convention

**Interfaces:**
- Produces `uploadBackup({ file, passphrase, onProgress, signal }): Promise<RestoreResponse>`.
- `onProgress` receives `{ loaded: number; total: number; percent: number }`.

- [ ] **Step 1: Write a failing helper test for upload progress and abort**

```ts
it('reports byte progress and rejects with AbortError when cancelled', async () => {
  const request = uploadBackup({ file, passphrase, onProgress });
  fakeXhr.emitProgress(50, 100);
  expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 100, percent: 50 });
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
});
```

- [ ] **Step 2: Run test and verify RED**

Expected: helper does not exist; existing pages call `File.text()` and JSON fetch.

- [ ] **Step 3: Implement XHR-only upload helper**

Create `FormData` with the file and passphrase. Set existing CSRF header for authenticated Settings upload; omit it only for first-run Setup. Do not set multipart `Content-Type` manually. Map non-2xx JSON errors to safe `Error` messages. Call `xhr.abort()` from `AbortSignal`.

- [ ] **Step 4: Implement Settings profile selector and restore state machine**

Use existing shadcn `Select`, `Progress`, `AlertDialog`, `Button`, and `Input` components. Add Compact default and Full forensic warning; do not add a second component system. Show bytes/percent during upload and indeterminate validating/restoring after 100%; disable destructive controls; expose Cancel only while uploading.

- [ ] **Step 5: Apply same helper to Setup and run browser tests**

Replace `importFile.text()` and JSON fetch. Verify accepted extensions `.ldb,.ldb.json`, progress display, cancel behavior, compact/full download choice, and success reload/login redirect.

### Task 7: Documentation, compatibility, and final gates

**Files:**
- Modify: `docs/07-SECURITY-ADMIN-AND-BACKUP.md`
- Modify: `docs/11-CACHING.md`
- Modify: `docs/10-TESTING-AND-ACCEPTANCE.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md` and `package.json` only when user explicitly requests a release/version bump.

**Interfaces:**
- Documents the `.ldb` v2 contract, compact exclusions, full profile, legacy restore window, max upload config, non-resumable upload behavior, operator rollback guarantee, and p95 limitation.

- [ ] **Step 1: Write documentation assertions/checklist before doc edits**

Create a small test or script that asserts the docs mention compact/full profile, `.ldb`, excluded request/audit/cache data, retained daily statistics, legacy JSON restore, progress/cancel, and no resume claim.

- [ ] **Step 2: Update authoritative docs and README**

Keep docs concise and point detailed format behavior to the design spec. State that full forensic backups can contain sensitive logged/cache content and compact backup cannot restore individual request/audit history.

- [ ] **Step 3: Expand backup acceptance coverage**

Add explicit tests/acceptance bullets for compact export/restore, full retention, aggregate statistics, p95 unavailable behavior, multipart progress/cancel/cleanup, legacy restore, and 150 MiB streaming fixture generated at runtime rather than committed.

- [ ] **Step 4: Run documentation check and all project gates**

Run:
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
docker compose config
docker compose up -d --build
```

Then probe `/health`, inspect container health/restarts, and exercise a safe browser/admin backup flow. Stop/report if Docker resources or test fixture capacity block a gate; do not claim it passed.

- [ ] **Step 5: Inspect the final diff without altering unrelated files**

Run:
```bash
git diff --check
git status --short
git diff -- docs src migrations README.md package.json CHANGELOG.md
```

Confirm only intentional feature/docs/test files changed. Do not commit/push/tag unless explicitly instructed.

## Plan self-review

- Spec coverage: Tasks 1/4 cover the binary v2 contract and compact/full export; Task 2/3 preserve/serve statistics; Task 5 covers streamed restore safety; Task 6 covers progress/cancel; Task 7 covers documentation and gates.
- No placeholders: every task names files, interfaces, test behavior, commands, and required outcomes.
- Type consistency: `BackupProfile`, `BackupManifestV2`, `createBackupExport`, `receiveBackupUpload`, and `uploadBackup` are defined once and used consistently.

## Execution handoff

Plan complete. Recommended execution is task-by-task with `superpowers:subagent-driven-development`; it enforces a fresh implementer and review gate for each task. Inline execution is possible with `superpowers:executing-plans`, but must keep the listed RED→GREEN cycles and checkpoint before task 4, where public backup format changes.
