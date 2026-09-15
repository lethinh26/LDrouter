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

## Codex OAuth operations

Create a **Codex** provider in the admin UI without an API key, then import a Codex OAuth `auth.json` as JSON, a JSON array, an `{ "accounts": [...] }` wrapper, or JSONL. Use the preview to inspect masked identity/expiry fields before selecting records. Account/workspace identity is provider-scoped for deduplication; email alone is not an identity key. Re-import updates encrypted credentials without resetting an administrator's enabled/disabled choice.

`LATEDEV_MASTER_KEY` is required to encrypt Codex access, refresh, and optional ID tokens. Tokens are decrypted only immediately before an upstream call and are never returned by the API, rendered by the UI, written to logs/audit metadata, or included in backups. Refresh runs near expiry and once after a 401/403; rotated tokens are persisted atomically. The import endpoint is admin-session and CSRF protected (`x-csrf-token`).

ZIP import and automatic Codex CLI config generation or mutation are deliberately unsupported in this release. The application never edits Codex CLI configuration files. The account **Test** action is a known limitation and returns sanitized HTTP 501 (`not_implemented`) without an upstream call or account-state mutation; normal routed requests are supported.

### Backup and restore

Back up the active SQLite data directory using the admin backup flow or a consistent SQLite snapshot. Keep the matching master key separately; a database backup does not contain it. Validate checksum/schema before restore and keep the original database until the restored copy passes integrity checks. A restore from another instance with a different master key leaves encrypted credentials undecryptable; re-save or re-import them rather than exposing token material.

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
