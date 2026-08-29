# 11 — Autonomous Implementation Order

Use Superpowers to convert this into a detailed internal task plan, then execute continuously. GitNexus must be used to understand existing code before editing when this is not a greenfield repository.

## Phase 0 — Repository understanding and plan

- Read all specification files.
- Run GitNexus analysis/index on the repository.
- Inspect existing package/build/test conventions.
- Use Superpowers planning workflow.
- Resolve conflicts in favor of: security requirements -> protocol correctness -> acceptance criteria -> light architecture -> cosmetic preferences.

## Phase 1 — Foundation

- TypeScript strict config
- Fastify server
- configuration loader + Zod
- SQLite/Drizzle setup + WAL + migrations
- React/Vite frontend
- shadcn/ui installation/configuration
- brand/theme tokens using `#d2004b`
- single-process static UI serving
- `/health` and `/ready`

Do not spend excessive time polishing the dashboard before backend primitives exist.

## Phase 2 — Admin security

- first-run setup
- Argon2id password auth
- secure session cookies
- CSRF strategy
- login/logout
- TOTP + recovery codes
- master-key encryption utilities
- audit logging primitive

Write security tests immediately.

## Phase 3 — Provider and model management

- provider CRUD
- encrypted credentials/custom secret headers
- OpenAI-compatible provider adapter
- Anthropic-compatible provider adapter
- Test Connection
- model discovery with pagination
- selective model import
- model capability metadata
- provider/model enabled and availability state

Build the Providers/Models UI in parallel with stable admin endpoints.

## Phase 4 — Gateway key security and limits

- `ld-` key generation
- digest storage / display once
- model ACL
- expiry
- IPv4/IPv6 CIDR rules
- trusted proxy client-IP resolution
- RPM
- TPM
- daily/monthly token quota
- concurrency
- max output cap

## Phase 5 — Canonical protocol layer

Implement and test:

- canonical content model
- OpenAI Chat Completions parser/encoder
- OpenAI Responses supported parser/encoder
- Anthropic Messages parser/encoder
- model-list endpoints
- token-count endpoint behavior
- error normalization
- tool calls
- stream event abstraction

Use mock upstreams heavily.

## Phase 6 — Routing

- aliases
- combos
- fallback
- weighted round robin
- capability filtering
- retry policy
- timeout policy
- circuit breaker
- passive/active health
- global attempt cap
- streaming fallback safety rule

## Phase 7 — Logs and statistics

- request record
- attempt records
- usage normalization
- content logging modes
- secret redaction
- filters/pagination
- statistics presets/aggregations
- retention cleanup
- DB size guard

No monetary cost code.

## Phase 8 — Caching

- provider prompt-cache passthrough/accounting
- gateway exact-response cache
- secure disabled-by-default policy
- SQLite cache storage + TTL/max-size eviction
- per-key and per-target controls
- cache invalidation/versioning
- cache hit logging/statistics
- streaming cache bypass

## Phase 9 — Full admin UI

Use shadcn/ui consistently.

Complete:

- Dashboard
- Providers
- Models
- Combos
- API Keys
- Requests
- Statistics
- Audit Logs
- Settings

Focus on operational clarity and secret-safe interactions.

## Phase 10 — Backup, metrics, operational hardening

- consistent DB backup
- restore validation + rollback
- Prometheus `/metrics`
- request IDs
- graceful shutdown
- structured application logs
- maintenance behavior for restore

## Phase 11 — npm + Docker Compose

- CLI binary
- production build
- package files allowlist
- `npm pack --dry-run`
- multi-stage Dockerfile
- non-root runtime
- root `docker-compose.yml`
- persistent named volume
- healthcheck
- `.env.example`
- README deployment instructions

## Phase 12 — Verification loop

Run the full acceptance suite.

For every failure:

1. use Superpowers debugging workflow
2. use GitNexus when impact spans modules
3. fix root cause
4. add/adjust regression test
5. rerun affected test class
6. rerun full suite before completion

Do not end on a red test/build.

## Decision defaults

When unspecified:

- choose fewer dependencies
- choose secure-by-default behavior
- choose explicit failure over silent semantic degradation
- choose stable IDs over human names for relations
- choose pagination over unbounded responses
- choose streamed processing over buffering
- choose metadata-only logging by default
- choose reversible admin operations/soft disable when historical data exists
- choose documented behavior over magic inference

## Forbidden shortcuts

Do not:

- hardcode upstream providers
- hardcode a model catalog
- import all discovered models automatically
- store plaintext secrets
- trust forwarded IP headers by default
- use an empty ACL to accidentally mean unrestricted
- merge multiple upstream streams into one client response after partial output
- delete missing upstream models and break history
- use a single request-log row to hide fallback attempts
- claim Anthropic/OpenAI compatibility while omitting protocol-specific stream/tool behavior
- add cost tracking
- add RBAC/multi-user complexity
- leave Docker Compose or npm packaging until an untested final minute
