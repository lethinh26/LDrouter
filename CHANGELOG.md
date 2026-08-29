# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

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
