# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.17.4] - 2026-09-18

### Fixed

- **An account that ran out of quota kept being retried instead of leaving the pool.** A quota refusal was classified `unknown`, which is not a routing decision: `isUpstreamHealthFailure` excludes it and `shouldFallback` answers false for it, so the pool selected the same spent account on every request and answered "usage limited". Live production data confirmed the shape — 49 quota refusals (`Codex upstream HTTP 429: The usage limit has been reached`, `Qoder account is out of quota`) recorded over 14 days, every one of them `failure_reason=unknown`, with the same `codex_account_id` / `qoder_account_id` retried each time. Quota is now its own failure class, checked before the error-type switch (a 429 reaches the classifier as `upstream_rate_limit`, which previously returned `http_status` before the quota test could run).
- **The exhausted account is now disabled, not just marked degraded.** Disabling (`enabled=0`) is the write that actually stops the churn: every selection path — `expandCodexAccountCandidates`, `expandQoderAccountCandidates`, `getCodexAccountForProvider`, `findEligibleQoderAccount` — filters on it, whereas `health_state` alone was overwritten to `healthy` by the next successful request. A Qoder billing block now disables the account too, instead of only degrading it.
- **A direct model never advanced to the next account.** The retry was gated on `comboPlan ? ... : false`, so the reported case — a direct `qoder/...` model, logged 33 times in production — never retried at all. A quota failure now always advances to the next candidate, combo or not; that is safe precisely because the exhausted account was just disabled, so the retry cannot land on it again.
- **The upstream 429 body was discarded, hiding the reason.** Quota exhaustion arrives as a plain 429 on OpenAI-compatible providers, with the wording ("you exceeded your current quota") only in the body — which `upstreamHttpError` dropped, leaving an account unclassifiable. The redacted body excerpt is now carried on a 429 too. A 429 without quota wording is still treated as a transient throttle: it retries the same account and does not disable it.
- **Re-enabling an account in the admin UI did not put it back in the pool.** The enable toggle flipped `enabled` but left `health_state=down`, which every selection filter excludes, so the account stayed unroutable while the panel showed it as enabled. Both the Codex and Qoder routes now clear the health verdict when re-enabling.

### Added

- **Usage and Credits are refreshed as the pool is used.** Both the Codex usage snapshot and the Qoder credits snapshot are re-read in the background after a successful request, throttled per account so a burst of traffic costs at most one extra upstream call, and never awaited — the response path is unaffected.

## [1.17.3] - 2026-09-17

### Added

- **Qoder accounts now show Credits — the account's real usage.** Qoder does not bill in tokens: its chat stream carries no usage block at all, so every Qoder request logged zero tokens and the panel had no usage figure to show. Credits are now read from Qoder's quota API (`GET /api/v2/quota/usage`) and shown per account: plan / add-on / org buckets, percentage used, expiry, and whether the quota is exhausted. A **Refresh credits** action re-reads them for every account.
- **Promotion-covered models are shown next to Credits.** Qoder keeps a model free by marking its catalog entry `is_free` — currently `qmodel_38max` (Qwen3.8-Max). Such a model spends no Credits, so an account at zero Credits still answers on it while every other model is refused. The panel now pairs **No plan credits** with **Free now: <model>** so a partly-working account reads as intended instead of looking like a router fault.

### Fixed

- **A Qoder quota refusal was reported as a token rejection.** The upstream returns HTTP 200 with a `403 code 112` envelope inside the streamed body for quota/billing refusals; the attempt classifier checked `401/403` before billing, so a depleted account was labelled "job token was rejected after a refresh" and the account was force-re-exchanged on every request. Billing-shaped refusals are no longer mistaken for credential failures.
- **The account Test button reported a blocked account as working.** It only probed the model catalog, which proves the PAT exchanges and nothing else — the refusal arrives as a `403` envelope inside an HTTP 200 body, so a check that never sends a message cannot see it. Test now sends one real request, preferring a promotion-covered model so testing never spends Credits, and names the free models that still work when the account is out of them.

## [1.17.2] - 2026-09-17

### Fixed

- **Every second message to a `codex/` model failed with `502 Codex upstream HTTP 400`.** The Responses `input` array was built with one content block type for all roles: assistant history went upstream as `input_text`, which the backend rejects ("Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'"). The first message of a conversation worked because it carries no assistant turn; every follow-up carries the previous answer, so chat, combo and agent traffic died from the second turn onward. Assistant prose is now sent as `output_text`. Verified live against chatgpt.com with a two-turn conversation (both turns 200).
- **Tool history was rejected the same way.** `function_call` and `function_call_output` are top-level `input` items on the Responses API, never content blocks — a call nested in `content` answers `400 invalid_value` listing the permitted block types. Tool calls and their results are now emitted as flat items correlated by `call_id`.
- **`Codex upstream HTTP 400` said nothing about the cause.** The upstream error body, which names the offending field (`param input[i].content[j]`), was discarded. It is now included in the thrown message, secret-redacted and truncated.

## [1.17.1] - 2026-09-17

### Added

- **Combo members are ordered by drag and drop.** The combo create/edit dialog lists members as sortable rows (`@dnd-kit`, the same interaction as the Codex and Qoder account pools): drag the handle — or reorder with the keyboard — and the row order becomes the saved priority, `position` 0 being tried first in fallback mode and leading the rotation in weighted round-robin.

### Fixed

- **`GET /api/admin/combos/:id` returned members in SQLite row order instead of priority order**, so a reordered combo could reopen showing the previous sequence. Members are now sorted by `position`.

## [1.17.0] - 2026-09-17

### Added

- **Qoder provider.** Qoder joins OpenAI, Anthropic and Codex as a first-class provider type, backed by personal access tokens (`pt-…`) that are exchanged for short-lived job tokens and stored encrypted. It brings a per-account pool with drag-to-reorder routing priority, live model-catalog import, an account health panel, bulk token import, and the signed (COSY) streaming and non-streaming chat client, including context-tier selection and the `Encode=1` body encoding.

### Fixed

- **Codex requests never satisfied the backend contract.** Every call answered `502 Codex upstream HTTP 400`: the backend requires `store: false` and `stream: true` verbatim. Non-streaming requests are now served by merging the upstream stream, which also restores tool calls — `response.completed` always carries `output: []`, so they are only observable on `response.output_item.done` and were previously dropped silently on both paths.
- **Expired Codex tokens could never be refreshed.** Routing and the account lookup rejected an account whose access token had expired, even though credentials are refreshed before use, so a healthy account stopped carrying traffic once its token aged out. The refresh client also omitted `client_id`, making every refresh fail on the backend side. Both are fixed and the account now recovers on the next request.
- **Codex rejected three optional parameters.** `max_output_tokens`, `temperature` and `top_p` each answered `400 Unsupported parameter`, so any client that set `max_tokens` against a `codex/` model failed — including the Models-page Test button, which always sets it. They are no longer forwarded; `instructions`, `tools` and `reasoning` still are.
- **Several admin actions failed with `403 CSRF token required`.** The model Test button, database backup create/restore, and the first-run database import called `fetch` directly instead of the shared client, so they carried no CSRF header while every authenticated admin mutation requires one. They now use a CSRF-aware wrapper; the first-run import is the deliberate exception, since no admin session exists yet.
- **The first-run database import was unreachable.** `POST /api/admin/backup/restore` answered `401 Login required` on a fresh instance, because its exemption from auth ran alongside the other admin modules' hooks on a shared scope, and a `preHandler` cannot cancel a later one. Backup routes now register in their own scope.
- **The Qoder account enable/disable button appeared dead.** The toggle wrote to the server correctly but never re-read the list, so the row kept showing its previous state. Test and Catalog had the same gap.

## [1.16.5] - 2026-09-15

### Fixed

- First-run setup failed with `Unable to acquire CSRF token`. The admin client fetched a CSRF token before every mutation, but `GET /api/admin/csrf` requires an admin session, which does not exist yet on `/setup`. Public mutation endpoints (`/api/admin/login`, `/api/admin/setup`) are now exempt from the CSRF pre-fetch.

## [1.16.4] - 2026-09-15

### Added

- Codex account pools are now part of `main`: native Codex OAuth providers, encrypted JSON/JSONL account import, token refresh/rotation, account-aware routing and fallback, model discovery, quota/usage panel, browser PKCE connect, and the Codex accounts UI.

### Fixed

- Admin sessions with a missing or expired CSRF row could not mutate anything (`Unable to acquire CSRF token`); the CSRF endpoint now re-issues a token for a valid session, and the admin client invalidates its cached token and retries once on an auth rejection.

## [1.16.3] - 2026-09-14

### Fixed

- **Routing rejections now name the model and the reason.** A request a model could not serve answered `No available model candidates` (direct model) or `No combo member satisfies the request capabilities or availability` (combo) — the same failure described differently, naming neither the model nor the cause. Both paths now share one taxonomy of capability gaps and availability reasons, grouped per model and reported with the model name without its provider prefix (`vl/gpt-5.5` is reported as `gpt-5.5`).
- **Error codes reached clients again.** `GatewayError.code` was dropped when each gateway route rebuilt the error from the runner outcome, so `rpm_limit`, `tpm_limit`, `quota_limit`, `concurrency_limit`, and `upstream_http_*` never left the process.
- **Admin-disabled models answered `404 Unknown model`.** The resolver skipped disabled models, so callers looked for a typo in a model that had just been switched off; it now reports `model disabled`. The candidate loader also pre-filtered disabled models and providers, making the recorded reasons unreachable and collapsing every case into `model not found`.
- **Upstream HTTP failures agreed across paths.** A 429 surfaced as 529 without a code on the non-streaming path and with one on another; all paths now share one mapping (429 → `upstream_http_429`, 401/403 → `upstream_http_401`/`upstream_http_403`, ≥500 → `upstream_http_503`).
- **No internal JS errors in responses.** A 200 with an unexpected body shape surfaced `Cannot read properties of undefined (reading '0')`; it is now `Upstream response for "<model>" has no "choices" array` with code `upstream_bad_response`.
- **Combo create/update no longer 500, leave orphans, or rename the public ID.** Uniqueness checked only `publicModelId` while `combos.slug` is its own UNIQUE column, duplicate members hit `UNIQUE(combo_id, model_id)`, and both operations ran outside a transaction — update deleting members before inserting the new ones. Saving the edit form unchanged also rewrote a public ID such as `smart` into `combo/smart`, breaking aliases and API keys. All uniqueness checks share one path, both operations are atomic, and the ID is never derived from the name.
- **Image requests to image-capable models failed.** `/v1/responses` dropped `input_image` blocks, Anthropic inbound read URLs from `source.data`, and outbound Anthropic conversion emitted `{"type":"url","media_type","data"}` instead of `source.url`.
- **Model capabilities are no longer guessed.** `inferOpenAICapabilities` wrote `image_input`, `structured_output`, and `reasoning` as `false` whenever a model name missed a substring heuristic, hard-rejecting `gpt-4o-2024-11-20`, `gemini-*`, `qwen-vl-*`, and `grok-*`. Unknown stays unknown; manual admin edits survive re-import.

## [1.16.2] - 2026-09-14

### Fixed

- npm release failed with `E409 Conflict - Failed to save packument`: the package had been renamed to `latedev-router`, which the registry still holds as an empty package after all of its versions were unpublished, so no new version can be written under that name. The package name is back to `ldrouter` (the name that last published successfully); the CLI still exposes both `ldrouter` and `latedev-router` binaries.

## [1.16.1] - 2026-09-13

### Fixed

- **Test connection** and **Import models** on the Codex accounts group always failed with `Gateway error`: the models request omitted the `client_version` query parameter the Codex endpoint requires, and the response was read from `models[].id` while the endpoint returns `models[].slug`, so discovery came back empty or errored.
- Deleting a Codex provider failed with `Gateway error`: `codex_accounts.provider_id` is `ON DELETE RESTRICT`, so removing the provider last raised a raw SQLite constraint error. The provider delete now removes the provider and its Codex account pool in one transaction and reports how many accounts were deleted.

## [1.16.0] - 2026-09-13

### Added

- Codex account pool UI: a dedicated Codex accounts group on the Providers page with expand/collapse, account filtering, and pagination — separate from the generic Add provider dialog, which no longer collects Codex credentials.
- Codex quota panel showing the 5-hour and weekly windows with live reset countdowns, per-account and refresh-all usage refresh, weekly reset-credit count, and a **Reset quota** action that spends one credit.
- Codex 5-hour window auto-start (opt-in per account): when a window is exhausted and its reset time has passed, the gateway sends one tiny ping so the next window opens immediately. One ping per reset minute, persisted so it survives restarts.
- Codex model import dialog with search, Select All, and existing-model detection.
- Connect OpenAI Codex: a browser-based PKCE flow that shows the authorize URL, waits for the loopback callback, and also accepts a pasted callback URL or bare authorization code. The verifier stays server-side and the authorization code is exchanged server-side, so neither ever appears in the UI.
  - `GET /oauth/codex/callback` captures the Codex CLI loopback redirect (`http://localhost:1455/auth/callback`) and holds the code in memory against its `state`; the dialog polls `GET /api/admin/codex/oauth/:state` and enables **Connect** as soon as a code is captured. The page never echoes the code.
- Drag-and-drop routing order for Codex accounts (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers`), replacing the numeric priority prompt. Rows can also be reordered with the keyboard; the saved order is the router's fallback order.
- `migrations/0006_codex_usage.sql`: usage snapshot, usage error, auto-start flag, and ping bookkeeping columns on `codex_accounts`.

### Fixed

- Codex account API returned `enabled` as SQLite `0`/`1` instead of a boolean, so the enable/disable control could show the wrong state.
- Codex credential refresh/decrypt failures returned an opaque HTTP 500 with `Gateway error`; they now return a typed 401 naming the fix (re-import the account).
- Codex model discovery threw a bare error without an HTTP status, so a 401 never triggered the refresh-and-retry path and surfaced as `Gateway error` instead of an auth failure.
- **Delete** on a Codex account was a soft delete that left the encrypted credentials on disk; it is now a hard delete. Past request attempts are unaffected because their account reference is `ON DELETE SET NULL`.
- The Codex account row rendered two identical Enable/Disable controls.

## [1.15.0] - 2026-09-12

### Added

- Native Codex OAuth account import from redacted JSON, JSON arrays, wrapper objects, and JSONL, with provider-scoped deduplication and encrypted token storage.
- Codex token refresh/rotation, bounded unauthorized retry, account health tracking, account-aware routing, and attempt attribution.
- Codex provider setup, account import, refresh status, enable/disable, and safe test controls in the admin UI.

## [1.14.1] - 2026-09-12

### Fixed

- Do not reject any model solely because its stored `reasoning` capability is `false`; reasoning support is advisory for OpenAI-compatible providers and must not block Claude/Hermes requests.
- Redact API-key digests and metadata from authentication debug logs.

## [1.14.0] - 2026-09-11

### Added

- **Docker request logging**: every request now emits structured `info` logs when received and a completion log classified as `info` (2xx/3xx), `warn` (4xx), or `error` (5xx), with request ID, method, route, status, and duration. Query strings, headers, bodies, and secrets are excluded.

## [1.13.1] - 2026-09-11

### Fixed

- **Update notification**: force a fresh npm registry check when the admin UI loads, so the update button is not hidden by the 15-minute cache.

## [1.13.0] - 2026-09-11

### Added

- **Passphrase-protected full backups**: backups now include administrator state and a master-key envelope protected by a user-entered six-digit passphrase; `/setup` can import them without recreating the admin account.

## [1.12.0] - 2026-09-05

### Added

- **Request-lifecycle debug logging** (`docs/13-LOGGING.md`): full observability of every request as it passes through the gateway, emitted to stdout/stderr so `docker logs` collects it.
  - Per-request ID (reuses `x-request-id` or generates one) tagged on every line — `docker logs ldrouter 2>&1 | grep req_xxx` reconstructs the whole lifecycle.
  - `[INCOMING]` → `[BODY SUMMARY]` → `[MESSAGES]` → `[TOOLS]` → `[MODEL RESOLVE]` → `[CAPABILITIES REQUIRED]` → `[CAPABILITY REJECT]` → `[ATTEMPT]` → `[UPSTREAM REQUEST]` → `[UPSTREAM RESPONSE]` → `[STREAM START/END/ERROR]` → `[DONE]`.
  - Per-candidate rejection reasons for the `No combo member satisfies...` error (why each member was filtered: `member_disabled`, `model_not_found`, `upstream_unavailable`, `circuit_open`, `tools`, `reasoning`, `streaming`, etc.).
  - Nested `error.cause` / undici stack capture for `UPSTREAM FETCH ERROR` (no more bare `fetch failed`).
  - Stream counters (chunks/bytes/first-chunk-ms) and client-disconnect detection.
  - `[CONFIG]` line at startup printing body limit + active debug flags.
  - Replaced `uncaughtException`/`unhandledRejection` no-op `{}` handlers with full message/stack/cause logging.
- **Debug env flags**: `DEBUG_HTTP`, `DEBUG_HTTP_BODY`, `DEBUG_UPSTREAM`, `DEBUG_STREAM`, plus `LOG_LEVEL` alias for `LATEDEV_LOG_LEVEL` (all default off; enable for one-shot reproduction).
- **Secret redaction**: all debug output routes through the existing `redact.ts` — provider keys are fingerprinted, never logged; `Authorization`/`x-api-key`/cookies always masked.

## [1.11.16] - 2026-09-04

### Fixed

- **Claude Code compatibility**: Added Zod `.passthrough()` to gateway routes to accept extra fields (`parallel_tool_calls`, `max_completion_tokens`, `stream_options`, `metadata`, etc.)
- **Combo model capability rejection**: Changed capability comparison from `!caps.field` to `caps.field === false` so models with undefined capabilities are treated as "potentially supported" instead of rejected
- **Cloudflare 502 errors**: Added robust error handling in streaming chunk handler, safe JSON defaults for capabilities parsing, process-level uncaught exception handlers
- **Response parser safety**: Added null/undefined checks in OpenAI response canonical conversion to prevent crashes on malformed upstream responses

### Testing

- Added unit tests for Claude Code compatibility (`tests/unit/claude-code-compatibility.test.ts`) - 9 tests covering Zod passthrough, capability handling, and safe JSON parsing

### Documentation

- Full root cause analysis documented in `DEBUG-COMPATIBILITY-ROOT-CAUSE.md`
- Deployment guide in `DEPLOYMENT-READY.md`

## [1.11.9] - 2026-09-04

### Fixed

- **API routes now return proper JSON errors**: fixed `setNotFoundHandler` logic to ensure `/v1/*` routes always return JSON error responses instead of falling through to HTML SPA index. Route order confirmed: health → admin/gateway → static files.

## [1.11.8] - 2026-09-03

### Fixed

- **ESLint flat config updated**: added debug scripts to ignore list in `eslint.config.mjs` (flat config replaces `.eslintignore` in ESLint v9+).

## [1.11.7] - 2026-09-03

### Fixed

- **API routes no longer return HTML on errors**: fixed route registration order so gateway routes (`/v1/*`) are registered BEFORE static file middleware, preventing API validation errors from serving SPA index.html instead of JSON error responses.

## [1.11.6] - 2026-09-03

### Fixed

- **Debug scripts excluded from linting**: initially used `.eslintignore`, then migrated to ESLint flat config proper syntax.

## [1.11.3] - 2026-09-03

### Fixed

- **Model Test streaming endpoint no longer returns an opaque 500 "Gateway error"**: when the provider credential can't be decrypted (master-key mismatch after backup restore), it now returns a readable `authentication_error` prompting to re-save the provider API key.
- **Docker container restart no longer causes data loss**: added `docker-entrypoint.sh` that removes stale SQLite WAL/SHM files on startup and performs a checkpoint to ensure all data is persisted to the main database file before starting the gateway.

## [1.11.2] - 2026-09-02

### Fixed

- **Custom API keys without an `ld-` prefix now authenticate**: the API-key creation form accepts any custom key value, but gateway authentication rejected every key not starting with `ld-` (401 "Invalid API key format"), making custom keys unusable. Authentication now accepts any stored secret verbatim — auto-generated keys still use the `ld-<base64url(32 bytes)>` format.

## [1.11.0] - 2026-09-01

### Added

- **Admin-site IP access control** (Settings → Access Control tab): Allow/Block IP lists (CIDR, one per line) now restrict access to the entire admin website — login, setup, and static UI included. Non-matching IPs get a plain 403 "Không có quyền truy cập". Model traffic (`/v1/*`) and `/health` are never affected. Lockout guard: saving a non-empty allow list auto-adds your current IP so you can't lock yourself out.
- **Live route lighting on /statistics**: while a request is being served — from the first token (TTFT) until completion — the Request → Gateway → Provider line lights up in the brand primary color with a soft pulsing glow; the completion pulse dot still flashes when the request finishes. Powered by a new live-only `request_started` SSE event.
- **API key editing**: the API keys page now has an Edit (✏️) button per key — name, expiry, RPM/TPM/concurrency limits, and model scope are editable via the existing dialog; the key secret itself is never changed on edit.

### Fixed

- **Ghost notifications**: reconnects (after the 5-minute stream cycle or a network drop) replayed recent requests over SSE, which re-triggered the notification card + sound even though no new request existed. The notification hook now dedupes by request ID across reconnects.
- **Model Test no longer returns an opaque 500 "Gateway error"** when the provider credential can't be decrypted (master-key mismatch, e.g. after restoring a backup from another instance): it now returns a readable `authentication_error` telling you to re-save the provider API key; the non-streaming test route also wraps unexpected runner errors instead of leaking them.

## [1.10.2] - 2026-09-01

### Fixed

- **API keys page no longer crashes after restoring a backup from another instance**: the key list/detail endpoints decrypt every stored key secret; a key encrypted with a different master key (restore from a different machine) threw an AES-GCM auth error that took down the whole request as a generic "Gateway error". Undecryptable keys now yield `secret: null` and the rest of the list still loads.
- **Creating an API key with an already-used custom secret** now returns a clear `409` ("An API key with this exact secret already exists…") instead of a raw SQLite `UNIQUE constraint failed` surfacing as a generic "Gateway error".

## [1.10.1] - 2026-09-01

### Fixed

- **Restore now reloads the database hot — no gateway restart needed**: `POST /api/admin/backup/restore` closes the in-process SQLite connection, swaps the file, reopens it in the same process, validates schema, and re-seeds the admin session — the admin stays logged in and sees the restored data immediately. Previously the admin had to restart the gateway after every restore.
- **Restore no longer loses data on restart**: the restore previously renamed over `data.sqlite` while the app's stale `-wal`/`-shm` sidecars were left behind; on restart SQLite could replay the old WAL over the restored snapshot, making the gateway appear empty (setup screen). The restore now fully closes the old connection before swapping, so the stale sidecars never survive.
- **Automatic rollback**: if the reopened restored database fails validation (e.g. schema mismatch), the gateway automatically rolls back to the pre-restore snapshot instead of staying broken.
- **Restore snapshot leak closed**: the pre-restore snapshot connection is now always closed.

### Changed

- Settings → Backup & restore now auto-reloads the admin UI after a successful restore (restore toast: "Restored. Reloading…").

## [1.10.0] - 2026-09-01

### Added

- **Real streaming model test**: clicking Test on a model now streams the upstream response token-by-token into the test dialog (`POST /api/admin/models/:id/test-stream` SSE endpoint, newline-delimited). Previously the dialog waited ~1s with no feedback before showing a static result; now content appears live as the model generates, with a blinking cursor, live TTFT/elapsed counter, and a final `test_meta` event with full latency/token/attempt stats. The old non-streaming `POST .../test` endpoint remains for backwards compatibility.

### Fixed

- **Test dialog no loading state**: the model test modal previously opened instantly but showed nothing for the ~1s the request took, looking like a hang. It now shows an immediate streaming view with progress as soon as the modal opens.

## [1.9.1] - 2026-09-01

### Fixed

- **Request-content logging now visible**: Settings → Logging "Request-content logging" was saving payloads to the database (`prompt` / `prompt_and_response` modes) but the admin UI never displayed them, making the setting appear broken. The request detail dialog on `/requests` now shows "Request content" and "Response content" sections (sanitized, scrollable) whenever payloads were logged. Added integration test covering all four `contentLogMode` values end-to-end.

## [1.9.0] - 2026-09-01

### Added

- **Realtime monitoring dashboard (/statistics)**: redesigned into a production-grade overview — summary cards now show icons, animated count-up, % delta vs previous period, and mini sparklines; a live **request routing flow** diagram (Incoming Traffic → AI Gateway → Providers with curved paths and animated pulse dots on each active route); a **Recent Requests** table with green/red status dots and time-ago labels; bottom metrics with circular Success Rate progress and Average Latency sparkline. All driven by the existing SSE stream (no new dependencies, CSS/SVG-native animations).
- **Stats API extensions**: `GET /api/admin/stats` now returns `previous` (same-window comparison for deltas), `recent` (last 10 requests with provider info), `providers` (traffic/error-rate/latency/health per provider), and per-bucket `avgLatency`/`cacheRead` in `series`; `RequestLogSummary` gained `providerId`/`providerName`.



### Added

- **Notification toggles in Settings**: request notification cards and the notification sound can each be turned on/off in Settings → System ("Notifications" card); preferences persist server-side (`app_settings`) and apply immediately across the whole admin UI.
- **Real-time /requests page**: the Requests log now subscribes to the SSE stream — new requests appear in the table live (page 1, honoring active filters) plus a "N new requests — refresh" badge, no manual page refresh needed.

### Fixed

- **Setup redirect (permanent fix)**: after creating the admin account the app now hard-reloads to `/login` instead of soft-navigating. Root cause: `SetupGate` cached `setupComplete=false` on mount and re-bounced every post-setup route back to `/setup`; a full reload clears the stale state.

## [1.7.0] - 2026-08-31

### Added

- **Real-time request notifications**: every gateway request completion shows a notification card in the admin UI (stacked, all visible simultaneously). Cards show model/request, in/out tokens, cache tokens, success/failure, duration + TTFT; auto-dismiss after 5s with manual close button; red on failure, amber when slow (>15s), default surface otherwise. Plays `notification.mp3` per notification.
- **SSE stream endpoint** (`GET /api/admin/requests/stream`): server-push of request log rows behind admin auth, with `since`-based history replay so clients never miss events across reconnects.

## [1.6.8] - 2026-08-31

### Added

- **Model test endpoint** (`POST /api/admin/models/:id/test`): Run a non-streaming request against a model with prompt "Bạn là model gì?", returns TTFT, total latency, token usage, and provider attempts.
- **Model delete action**: Replace enable/disable toggle with explicit Delete button + confirmation modal and Test button showing results.
- **Combo edit functionality**: New edit dialog (via `/api/admin/combos/:id`) and PATCH handler for modifying combo metadata/members.
- **Searchable member picker**: Dropdown in create/edit combo dialogs now filters models by public ID or display name.
- **API key actions**: Split Revoke into Disable/Enable toggle + Delete button; persist secret visibility for each key row.
- **Dynamic sidebar version**: Footer displays real app version fetched from server instead of hardcoded `v0.1.0`.

### Fixed

- **TOTP speakeasy v2 compatibility**: Fixed API migration — removed deprecated `authenticator` namespace, replaced with direct v2 exports (`generateSecret`, `totp.verify({encoding:'base32'})`, `otpauthURL`). Eliminates "Gateway error" when enabling TOTP. Also fixed login flow verification to use same pattern.

### Changed

- **Language**: UI labels updated to Vietnamese where appropriate ("Xoá", "Sửa").

## [1.6.7] - 2026-08-30

### Fixed

- **TUI render corruption** (v1.6.4): Fastify deprecation warnings were writing
  directly to stdout/stderr during TUI startup, causing text overlap in the
  terminal UI (e.g., `● Server is runninging…`). Added console output suppression
  in TUI mode: all stdout suppressed, stderr filtered to only allow critical error
  messages that the TUI itself will render in its message screens. Also reduced
  Pino logger level from `info` → `error` for any logs generated by buildApp().

### Changed

- **Auto-TUI mode**: Running `ldrouter` without arguments now automatically
  enters interactive TUI when stdout is a TTY. Added `--no-tui` flag to force
  plain server mode (useful for CI pipelines, logging redirects, etc.).

### Added

- **Update notification badge in admin UI top bar**: When a new version is
  available, users see an "Update vX.Y.Z" button that links directly to
  Settings → System tab with one-click installation. Previously the check existed
  but required manual navigation; now it's surfaced at glance in the header.

- **Settings page auto-tab selection**: Now reads `?tab=system` query param from
  URL to automatically show the System tab (used by the top bar update
  notification link for direct access).

## [1.6.3] - 2026-08-30

### Fixed

- **TUI render corruption**: Fastify deprecation warnings and log messages were
  writing directly to stdout/stderr during TUI startup, causing text overlap
  and breaking the terminal UI layout (e.g., `● Server is runninging…`). Added
  console output suppression in TUI mode: all stdout suppressed, stderr filtered
  to only allow critical error messages that the TUI itself will render in its
  message screens. Also reduced Pino logger level from `info` → `error` for any
  logs generated by buildApp().

### Changed

- **Auto-TUI mode**: Running `ldrouter` without arguments now automatically
  enters interactive TUI when stdout is a TTY. Added `--no-tui` flag to force
  plain server mode (useful for CI pipelines, logging redirects, etc.).

## [1.6.3] - 2026-08-30

### Changed

- **TUI mode defaults**: Running `ldrouter` without args now enters interactive
  TUI automatically if stdout is a TTY. Added `--no-tui` flag to force plain
  server mode when needed (e.g., CI pipelines, logging redirects).

### Fixed

- **Log pollution in TUI**: Reduced log level from `fatal` → `error` so that
  deprecation warnings and other routine logs don't break the terminal UI
  layout. Raw stdin mode activated earlier to capture all key presses cleanly.

## [1.6.2] - 2026-08-30

### Fixed

- **CI/CD:** GitHub Actions now builds `dist/` before publishing to npm (the
  previous release missed the build step in the `npm-publish` job; manual
  `scripts/publish.sh` always ran `pnpm build`). The published tarball now
  includes the CLI binary so `ldrouter --tui` works after `npm install -g`.

## [1.6.1] - 2026-08-30

### Added
- Interactive console UI: `ldrouter --tui` boots the gateway and shows a
  zero-dependency terminal menu (open dashboard, check/apply updates, exit)
  with live uptime; falls back to the plain server when stdout is not a TTY.

### Changed
- CI: npm tarball verification prints the full pack output with explicit
  per-file error messages; the redundant `prepack` build hook was removed.

## [1.6.0] - 2026-08-30

### Added
- Public releases: GitHub Actions publishes `ldrouter` to npm (with
  provenance) and builds the multi-arch Docker image
  `ghcr.io/lethinh26/ldrouter` (`X.Y.Z`, `X.Y`, `latest`) on every `vX.Y.Z`
  tag; manual fallback via `scripts/publish.sh`.
- Docker auto-update via an opt-in Watchtower sidecar
  (`docker compose --profile updater up -d`): hourly image pulls plus an
  instant "Update now" button in Settings → System that triggers Watchtower's
  HTTP API; `/data` survives container recreation.
- Release tooling: `pnpm release:patch|minor|major` (runs gates, bumps the
  version, tags `vX.Y.Z`); release process documented in CLAUDE.md.
- Docker images are version-stamped (`APP_VERSION` build arg +
  `LATEDEV_APP_VERSION`) with OCI labels.

### Changed
- Single source of truth for the app version (`src/server/version.ts`);
  the npm-mode self-update now shuts down gracefully (SIGTERM) instead of a
  hard `process.exit`.

### Fixed
- Dockerfile `COPY ../migrations` (invalid path outside the build context)
  → `COPY migrations`; `/health` and backups reported hardcoded `0.1.0` in
  Docker where `npm_package_version` is unset.

## [1.5.1] - 2026-08-30

### Fixed
- Self-update reported version `0.0.0` in Docker/direct-node runs where
  `npm_package_version` is unset; it now reads the version from the
  package.json on disk.

## [1.5.0] - 2026-08-30

### Added
- Self-update: check the npm registry for newer versions and update in place
  from the admin UI (Settings → System). Detects the installing package
  manager (npm / pnpm / yarn / bun) and restarts the server after installing.
- `/v1/models` now lists the full routable surface: physical models, enabled
  combos, and enabled aliases (previously only physical models), honoring
  per-key model ACLs.
- Combos created without a slug use their name as the model ID (e.g.
  `gpt-5.5`), keeping dots intact; an explicit slug still yields
  `combo/<slug>`. Duplicate IDs across combos/models are rejected.
- Release tooling: package renamed to `ldrouter` (CLI `ldrouter`), versioning
  policy documented in CLAUDE.md.

### Fixed
- `/statistics` stuck on "Loading…": the stats queries ordered by a quoted
  select alias (`c`), which SQLite rejects ("no such column: c"). They now
  order by the `COUNT(*)` expression; the page also shows an explicit error
  state instead of failing silently.
- Provider actions (test/delete) failed with "Gateway error": bodyless
  `POST`/`DELETE` calls sent an empty JSON body that Fastify rejects; the
  client now only sends `content-type: application/json` when a body exists.
- Provider operations failed with an opaque "Gateway error" when the master
  key was unset: empty-string env vars (e.g. from docker-compose) shadowed
  the `master.key` file; config now ignores empty env values. Errors are
  logged with detail instead of being swallowed.
- Setup now requires the master encryption key up front (no silent
  auto-generate) and validates it before creating any state.

## [1.4.2] - 2026-08-29

Baseline release of the LateDev Router gateway: Fastify server, SQLite WAL
storage, canonical OpenAI/Anthropic protocol layer, combo routing
(fallback / weighted round-robin), encrypted credentials, admin UI, backup
& restore, request logs and statistics.
