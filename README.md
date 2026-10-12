# LateDev Router

Lightweight self-hosted LLM gateway with a polished admin UI. Presents stable OpenAI-compatible and Anthropic-compatible APIs to clients while routing traffic to one or more upstream providers.

## Features

- OpenAI-compatible and Anthropic-compatible gateways (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`)
- Selective model discovery (Fetch → select → import) with **Select All**
- Ordered **combos** with fallback routing and one-hop **aliases**
- Provider API keys encrypted at rest with AES-256-GCM
- Per-key `ld-` bearer tokens (SHA-256 digest storage, displayed once)
- IP allow/deny (IPv4 + IPv6 CIDR), trusted-proxy configuration
- Rate limits: RPM, TPM, daily/monthly token quotas, concurrency, max output tokens
- TTL-based gateway response cache (disabled by default) + provider prompt-cache accounting
- Streaming end-to-end with strict "no fallback after stream content sent" rule
- Request + attempt logs, statistics (Today / 7d / 30d), retention cleanup
- Admin TOTP 2FA, Argon2id passwords, recovery codes
- Immutable audit logs
- Consistent backup / restore: compact `.ldb` default + full forensic profile, streamed upload with progress/cancel
- Prometheus `/metrics`, structured logs, graceful shutdown
- One distributable npm package, multi-stage Dockerfile, Docker Compose

## Quick start

### Using Docker Compose

```bash
cp .env.example .env
# Edit LATEDEV_MASTER_KEY (32+ bytes base64). Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
docker compose up -d
```

Then visit `http://localhost:8787/` and complete the first-run admin setup.

### Using npm

```bash
npx ldrouter
latedev-router --host 0.0.0.0 --port 8787
```

The data directory defaults to `~/.latedev-router/` and can be overridden via `LATEDEV_DATA_DIR` or `--data-dir`.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LATEDEV_HOST` | Bind host | `0.0.0.0` |
| `LATEDEV_PORT` | Bind port | `8787` |
| `LATEDEV_DATA_DIR` | Persistent data directory | `~/.latedev-router/` |
| `LATEDEV_MASTER_KEY` | 32-byte base64 key for encrypting provider credentials | _required once providers exist_ |
| `LATEDEV_TRUST_PROXY` | Number of reverse-proxy hops to trust for X-Forwarded-For | `0` |
| `LATEDEV_LOG_LEVEL` | trace / debug / info / warn / error / fatal | `info` |
| `LATEDEV_MAX_BACKUP_UPLOAD_BYTES` | Maximum accepted backup restore upload size (bytes) | `268435456` (256 MiB) |

## Backup & restore

Backups download from Settings > Backup (or first-run Setup). New backups use the binary `.ldb` container; legacy `.ldb.json` files remain restoreable.

- **Compact (default)** — retains all gateway configuration, encrypted provider credentials, API-key configuration, quota usage, and daily statistics by model/provider/API key. It excludes requests, attempts, audit logs, and the gateway response cache, so it is much smaller and is the right choice for routine backups.
- **Full (forensic)** — retains every raw row, including request/attempt/audit and cached response content. It can be much larger and contains sensitive data; treat the file as confidential.

To restore, upload the `.ldb` file (or legacy `.ldb.json`) and enter the **same six-digit passphrase** used to create it — it decrypts the encrypted master key inside the backup. Without it, restored provider credentials cannot be decrypted. The upload streams to disk with real progress and a Cancel button; **uploads are not resumable**, so an interrupted upload must be restarted. The default upload size limit is 256 MiB (`LATEDEV_MAX_BACKUP_UPLOAD_BYTES`); over-limit uploads are rejected with HTTP 413.

Restore validates the container, checksum, gzip, SQLite integrity, schema version, and key envelope before an atomic swap, and keeps a pre-restore snapshot so a failure rolls back to the previous database.

**Limitation:** a compact backup cannot restore individual request/attempt/audit history or cached responses, and after a compact restore historical p95 latency and p95 TTFT percentiles are unavailable for aggregate-only days (average latency/TTFT and top rankings are retained). Use a full backup if you need that row-level detail or percentile history.

## Public API examples

OpenAI-compatible:
```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer ld-..." \
  -H "content-type: application/json" \
  -d '{"model":"provider/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Anthropic-compatible:
```bash
curl http://localhost:8787/v1/messages \
  -H "x-api-key: ld-..." \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"provider/claude-3-5-sonnet-latest","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

## Build & test

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
docker build -t latedev-router:test .
docker compose config
docker compose up -d
```

## Development

```bash
pnpm install
pnpm dev
# In another terminal
pnpm --filter . typecheck
pnpm test
```

## Architecture

See `AGENTS.md` and the `docs/` directory for the full specification.
