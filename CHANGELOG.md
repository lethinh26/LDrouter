# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.11.7] - 2026-09-03

### Fixed

- **API routes no longer return HTML on errors**: fixed route registration order so gateway routes (`/v1/*`) are registered BEFORE static file middleware, preventing API validation errors from serving SPA index.html instead of JSON error responses.

## [1.11.6] - 2026-09-03

### Fixed

- **Debug scripts excluded from linting**: added `.eslintignore` for utility scripts that use Node.js globals intentionally.

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
