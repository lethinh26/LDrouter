# LateDev Router — Autonomous AI Implementation Contract

> This file is the primary instruction file for an autonomous coding agent. Read this file first, then read every document in `docs/` in numeric order before writing production code.

## 1. Mission

Build **LateDev Router**, a lightweight self-hosted LLM gateway with a web administration UI. The product must be usable by a single administrator, installable/runnable from npm, and deployable with Docker Compose.

The agent is expected to work autonomously from initialization to a production-ready implementation. There will be no developer intervention during normal implementation.

## 2. Mandatory agent skills and workflow

The execution environment is guaranteed to provide these skills/tools. Use them rather than ignoring them:

1. **Superpowers**
   - Use it before implementation to generate an execution plan from this specification.
   - Use its debugging/testing workflow whenever a test or implementation step fails.
   - Keep the implementation moving until the acceptance criteria are satisfied.

2. **GitNexus**
   - Use it before modifying an existing repository to understand the current code graph, dependencies, entry points, and impacted modules.
   - Re-run/re-index it after meaningful architectural changes when needed so later edits are based on the actual current repository.
   - Do not blindly refactor files without checking impact through GitNexus.

3. **shadcn/ui**
   - Use shadcn/ui as the UI component foundation.
   - Prefer shadcn components for buttons, dialogs, tables, dropdowns, forms, tabs, badges, tooltips, popovers, sheets, selects, alerts, pagination, toasts, cards, command/search UI, etc.
   - Use Lucide icons through the normal shadcn ecosystem.
   - Do not create a second competing component system.

## 3. Execution rules

- Do not ask the user product questions that are already answered by these documents.
- When a minor implementation detail is unspecified, choose the simplest secure production-sensible option and document the choice.
- Do not stop after scaffolding, mockups, or partial CRUD. Continue through backend, frontend, migrations, tests, packaging, Docker, and documentation.
- Do not replace required behavior with TODOs or placeholders.
- External provider tests may use mocks when real credentials are unavailable, but the real provider code paths must be implemented.
- Keep dependencies intentionally small. Do not introduce Redis, PostgreSQL, Kafka, Kubernetes, Next.js, NestJS, or other infrastructure unless a requirement truly cannot be met without it. This specification is designed so they are not required.
- Prefer native Web APIs and Node APIs where practical.
- Preserve streaming end-to-end. Never buffer an entire streaming LLM response just to simplify implementation.
- Security-sensitive values must never be written to logs.
- All database schema changes must use migrations.
- Maintain a clean `README.md` for human operators in addition to these internal implementation documents.

## 4. Required technology baseline

Use this baseline unless the existing repository already has an equivalent lightweight stack that clearly satisfies all requirements:

- Runtime: **Node.js >= 22**
- Language: **TypeScript**, strict mode
- Package manager during development: **pnpm**
- HTTP server: **Fastify**
- Database: **SQLite**, WAL mode
- ORM/query layer: **Drizzle ORM** + migrations
- Web UI: **React + Vite + TypeScript**
- UI components: **shadcn/ui + Tailwind CSS + Lucide icons**
- Validation: **Zod**
- Testing: **Vitest**, plus an HTTP/integration test layer suitable for Fastify
- Browser/E2E tests: **Playwright** for critical admin flows
- Build/package: one distributable npm package exposing a CLI/binary named `latedev-router`

The runtime deployment must be a single application process by default. The built React app is served by the same Node server.

## 5. Product identity and visual system

- Product name: **LateDev Router**
- Primary brand color: **`#d2004b`**
- The UI must feel like a polished developer infrastructure product: clean, dense enough for operations, but not visually noisy.
- Support light and dark themes.
- Derive secondary colors from neutral shadcn tokens and semantic colors for success/warning/error. Do not flood large surfaces with the primary red/magenta.
- Use the primary color for primary actions, active navigation, key highlights, selected states, charts where appropriate, and branding.

## 6. Explicitly in scope

Implement all requirements described in `docs/`, including:

- OpenAI-compatible and Anthropic-compatible provider support.
- Selective model discovery with modal selection and Select All.
- Provider-prefixed public model names.
- Virtual combo models with fallback or weighted round robin, configurable per combo.
- Capability-aware routing.
- Provider/model health, circuit breaker, retries, and timeouts.
- API key restrictions, quotas, expiry, IP/CIDR rules.
- API keys beginning with `ld-`.
- Request logs and per-attempt logs, without monetary cost tracking.
- Provider prompt-cache accounting plus optional gateway response caching, with gateway cache disabled by default.
- Statistics for today / 7 days / 30 days, including top models.
- Configurable log retention.
- Database download/restore.
- Password change and TOTP 2FA.
- Provider credential encryption.
- Audit logs.
- Request IDs and metrics/health endpoints.
- Model aliases.
- Dockerfile and Docker Compose deployment.
- npm package / `npx` execution.

## 7. Explicitly out of scope

Do not implement these unless they are strictly required internally:

- Monetary cost calculation, price tables, cost dashboards, cost limits, or billing.
- RBAC, teams, organizations, or multi-user administration.
- SSO/SAML/OIDC.
- Nested combos. A combo contains physical provider models only.
- Kubernetes deployment manifests.
- A dependency on Redis or another external cache service.

## 8. Definition of done

Do not consider the project complete until all of the following are true:

- `pnpm lint` passes.
- `pnpm typecheck` passes.
- unit tests pass.
- integration tests pass.
- critical Playwright flows pass.
- migrations work from an empty database.
- the application starts with a persistent SQLite volume.
- Docker image builds successfully.
- `docker compose up` starts a usable instance with a health check.
- npm package build creates the CLI and bundled web assets.
- the gateway successfully handles mocked OpenAI-compatible and Anthropic-compatible streaming and non-streaming requests.
- fallback and weighted round robin behavior are tested.
- key restrictions and rate limits are tested.
- secret redaction is tested.
- backup/restore validation is tested.
- all acceptance criteria in `docs/10-TESTING-AND-ACCEPTANCE.md` pass, including cache behavior.
- operator documentation is accurate.

Read next: `docs/00-PRODUCT-SCOPE.md`.
