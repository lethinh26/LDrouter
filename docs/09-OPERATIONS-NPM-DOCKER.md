# 09 — Operations, npm Packaging, Docker, and Observability

## npm package

Publishable package name is **`ldrouter`**. The name `latedev-router` is held on the registry by an empty, treated-as-unpublished package, so writing a new version under it fails with `E409` until npm support releases it. Both binary names stay available: the package is `ldrouter` and exposes `ldrouter` and `latedev-router`.

`package.json` must expose a binary entry:

```json
{
  "bin": {
    "latedev-router": "./dist/cli.js",
    "ldrouter": "./dist/cli.js"
  }
}
```

The package must include:

- server bundle
- web static assets
- DB migrations
- any required runtime metadata

Exclude source-only/test artifacts from the npm tarball unless useful for license/documentation.

Verify with:

```bash
npm pack --dry-run
```

Required run modes:

```bash
npx ldrouter
latedev-router
latedev-router --host 0.0.0.0 --port 8787
```

The package build runs `build:web` before `build:server`; `dist/cli.js`, the server bundle, `dist/web` static assets, and root `migrations/` are included in the npm tarball. Verify the file list with `npm pack --dry-run`.

## Retired provider integrations

Only OpenAI-compatible and Anthropic-compatible provider configurations are supported. Migration `0014_remove_legacy_providers.sql` removes the retired Codex and Qoder integrations, their account/credential tables, provider/model configuration, and invalid references. It retains request/attempt/audit history and daily aggregates; combos keep surviving members in their original priority order, and combos with no members left are disabled. Restricted API keys remain restricted even if their allowlist becomes empty. Historical migration files are retained solely for upgrading older databases.

Before upgrading from a database with retired providers, take a **full** backup and keep its passphrase/master-key material safe. The removed provider credentials and configuration cannot be recovered from the upgraded database. Restore an earlier backup with the corresponding earlier application version if a downgrade is required; restoring it into the current application applies migration 0014 on staging and removes the retired configuration again.

### Backup and restore

Back up the active SQLite data directory using the admin backup flow or a consistent SQLite snapshot. The `.ldb` backup includes a passphrase-protected key envelope; a raw SQLite snapshot requires the matching master key separately. Validate checksum/schema before restore, migrate older backups on staging, and keep the original database until the restored copy passes integrity checks. Never expose credential material.

CLI flags may override environment variables.

## Docker image

Create a production multi-stage `Dockerfile`.

Requirements:

- build frontend and backend in builder stage
- production stage contains only required runtime files/dependencies
- run as a non-root user
- persistent data at `/data`
- listen on configurable host/port
- include a container health check or Compose health check hitting `/health`
- do not bake secrets into layers

## Docker Compose

A root-level `docker-compose.yml` is mandatory.

Expected shape:

```yaml
services:
  latedev-router:
    build: .
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      LATEDEV_HOST: 0.0.0.0
      LATEDEV_PORT: 8787
      LATEDEV_DATA_DIR: /data
      LATEDEV_MASTER_KEY: ${LATEDEV_MASTER_KEY}
    volumes:
      - latedev-router-data:/data
    healthcheck:
      # call /health

volumes:
  latedev-router-data:
```

The actual final Compose file must use correct syntax/commands for the implemented image.

Also provide `.env.example` with safe placeholders. Never commit a real master key.

## Health endpoints

### `/health`

Liveness only. Fast and does not depend on upstream LLM providers.

Example semantics:

```json
{
  "status": "ok",
  "version": "..."
}
```

### `/ready`

Readiness checks core local dependencies such as database availability/migrations. It should not become unavailable merely because one optional upstream provider is down.

Return useful but non-sensitive failure detail.

## Metrics

Expose Prometheus text format at `/metrics`.

At minimum:

- gateway requests total by protocol/status class
- request duration histogram
- TTFT histogram
- input/output/cache/reasoning token counters
- upstream attempts total by provider/model/result
- upstream attempt duration histogram
- fallback count
- active requests gauge
- provider circuit state gauge
- rate-limit denial counters

Be mindful of metric-cardinality explosion. Do not label metrics by request ID, IP, or API key secret. API-key labels should generally be avoided; if needed, use stable internal IDs only with explicit cardinality consideration.

## Request IDs

Generate a unique gateway request ID for every gateway API call. Use an opaque, sortable identifier if convenient.

Expose it in a response header such as:

```text
x-request-id
```

Track separately when available:

- client-provided request/correlation ID
- gateway request ID
- upstream request ID

Never trust client correlation IDs as unique database keys.

## Graceful shutdown

On SIGTERM/SIGINT:

- stop accepting new requests
- allow in-flight requests a bounded grace period
- abort remaining upstream requests after the deadline
- close DB cleanly

This matters for Docker restarts.

## Logging

Application logs are structured and should include request IDs, but never request/API/provider secrets.

Support configurable log level.

## Reverse proxy deployment

Document:

- HTTPS termination expectation
- trusted proxy configuration
- forwarded client IP behavior
- WebSocket is not required for LLM streaming; SSE/chunked HTTP must work through reverse proxies
- proxy buffering should be disabled for streaming endpoints where relevant

Read next: `10-TESTING-AND-ACCEPTANCE.md`.
