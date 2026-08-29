# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Greenfield spec pack for **LateDev Router**, a lightweight self-hosted LLM gateway with a web admin UI. There is no production code yet — the authoritative source of truth is `AGENTS.md` plus the numbered docs in `docs/`. Read `AGENTS.md` first, then `docs/00-` through `docs/12-` in order, before writing any code. Do not ask product questions already answered by these docs; for unspecified minor details, choose the simplest secure production-sensible option and document it.

Startup entry point for autonomous builds: `AUTONOMOUS-BUILD-PROMPT.md`.

## Required tech baseline (per AGENTS.md)

- **Node.js >= 22**, **TypeScript strict**, package manager **pnpm**
- HTTP server: **Fastify**; DB: **SQLite (WAL)**; ORM: **Drizzle ORM + migrations**
- Web UI: **React + Vite + TypeScript**, **shadcn/ui + Tailwind + Lucide icons**
- Validation: **Zod**; Testing: **Vitest** + Fastify integration tests + **Playwright** for critical admin flows
- One distributable npm package exposing CLI `latedev-router`; Dockerfile + root `docker-compose.yml`
- Keep dependencies small. **No** Redis, PostgreSQL, Kafka, Kubernetes, Next.js, NestJS. Single process + single SQLite file by default; built React assets served by the same Node server.

## Build / verify commands

From `docs/10` (acceptance gates — do not claim completion while any fail):

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run          # binary + web assets + migrations in tarball
docker build -t latedev-router:test .
docker compose config
docker compose up -d        # /health must become healthy, UI loads
```

CLI runs: `npx latedev-router`, `latedev-router --host 0.0.0.0 --port 8787`. Env vars `LATEDEV_HOST/PORT/DATA_DIR/MASTER_KEY/TRUST_PROXY/LOG_LEVEL`. Default data dir `~/.latedev-router/`, container default `/data`.

## Big-picture architecture (spans several docs)

**Routers are software modules, not services.** One process owns the whole stack: HTTP compatibility layer → auth/IP/limits → model/alias resolver → combo router → protocol adapters → upstream client → logs/metrics/audit → admin API → static UI, over one SQLite WAL database.

- **Canonical protocol layer, not N×N adapters** (`docs/01`, `03`): all client requests parse into one canonical internal content/request model, route as canonical, then encode to the target upstream and back to the originating client protocol. Compatibility is semantic (streaming, errors, tool calls, usage, finish reasons, headers). Missing capability must be rejected with a pre-upstream error, never silently degraded.
- **Request pipeline order** (`docs/01`, `04`): request ID → client IP (`LATEDEV_TRUST_PROXY`-gated, never trust forwarded headers by default) → key auth → IP allow/deny → key expiry/status → endpoint validation → model/alias resolution (one hop only, no alias→alias) → model ACL → admission (RPM/TPM/concurrency) → canonical conversion → capability derivation → candidate selection → upstream attempt loop → streaming → usage → persist request+attempts → metrics.
- **Routing** (`docs/04`): candidate pipeline filters disabled/unavailable/circuit-open/incompatible models; combos are fallback (ordered) or weighted round-robin over physical models only (no nested combos), with per-combo failure-class triggers and a global `max_total_attempts` cap. **Streaming fallback rule is a hard invariant**: fallback only before semantically committed output; once stream content is sent to the client, never concatenate another model's response.
- **Secrets everywhere are one-way or encrypted at rest, never logged** (`docs/02`, `05`, `07`): gateway keys are random `ld-…`, shown once, stored as SHA-256 digest; provider keys are AES-256-GCM encrypted with `LATEDEV_MASTER_KEY` (required once encrypted creds exist, never in SQLite/backup/logs); admin password Argon2id; TOTP secret encrypted, recovery codes hashed. Audit logs are immutable and exempt from request-log retention.
- **Two distinct "caches" — never conflated** (`docs/11`): provider prompt caching (upstream feature, passthrough + token accounting only) vs. optional gateway response cache (SQLite-backed, exact-key on canonical serialization, **disabled by default**, non-streaming success only, TTL/max-size, version-busted on combo/alias change).
- **Logs & stats without money** (`docs/02`, `06`): one `requests` row + per-`request_attempts` rows; server-side paginated filtering; retention cleanup with chunked deletes; stats presets Today/7d/30d with explicit timezone semantics. Cost/billing, RBAC/multi-user, SSO are all out of scope.

## Locked product / design decisions

- Primary brand color `#d2004b`; neutral surfaces, semantic red stays distinct for errors; light + dark themes.
- Public model IDs `provider-slug/upstream-id`, combos `combo/<slug>`, aliases resolve one hop. Slugs are mutable — UUIDs are the relational keys.
- Discovery is **never auto-import**: Fetch → selective modal (with Select All) → explicit import. Missing upstream models become `upstream_available=false` (tombstone, never deleted) to preserve history/combo refs.
- Deleting providers/models/keys is soft-disable/tombstone where history references exist. Key ACL: an empty allowlist means **deny all**; unrestricted requires an explicit `allow_all_models` flag.
- Backup/restore: consistent SQLite snapshot, checksum+integrity+schema-version validated, refuses future schema, rolls back on failure. Restore never executes SQL from uploads.

## Mandatory workflow for this project

This spec requires the agent to use these skills (see `AGENTS.md` §2, `docs/12`):

1. **Superpowers** — plan before implementation; its debugging/testing workflow on every failure before fixing.
2. **GitNexus** — understand impact before non-trivial edits and after major architectural changes (relevant once code exists; re-index after structural growth).
3. **shadcn/ui + Lucide** — the only component system for the admin UI; no second competing system.

When unspecified, decision defaults: fewer dependencies, secure-by-default, explicit failure over silent degradation, stable IDs over names for relations, pagination over unbounded responses, streamed processing over buffering, metadata-only logging by default, soft-disable over delete, documented over magic.

## Test layers (for navigation once code exists)

`tests/unit` (pure logic: routing math, CIDR, redaction, capability derivation, protocol mapping), `tests/integration` (server vs temp SQLite + mock upstream HTTP), `tests/e2e` (Playwright critical admin flows), plus the routing acceptance scenarios and security-scan scenarios in `docs/10`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **LateDev Router** (1429 symbols, 3482 relationships, 109 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/LateDev Router/context` | Codebase overview, check index freshness |
| `gitnexus://repo/LateDev Router/clusters` | All functional areas |
| `gitnexus://repo/LateDev Router/processes` | All execution flows |
| `gitnexus://repo/LateDev Router/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
