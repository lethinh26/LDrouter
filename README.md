# LateDev Router

Lightweight self-hosted LLM gateway with a polished admin UI. Presents stable OpenAI-compatible and Anthropic-compatible APIs to clients while routing traffic to one or more upstream providers.

## Features

- OpenAI-compatible and Anthropic-compatible gateways (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`)
- Selective model discovery (Fetch → select → import) with **Select All**
- Virtual **combos** (fallback or weighted round-robin) and one-hop **aliases**
- Provider API keys encrypted at rest with AES-256-GCM
- Per-key `ld-` bearer tokens (SHA-256 digest storage, displayed once)
- IP allow/deny (IPv4 + IPv6 CIDR), trusted-proxy configuration
- Rate limits: RPM, TPM, daily/monthly token quotas, concurrency, max output tokens
- TTL-based gateway response cache (disabled by default) + provider prompt-cache accounting
- Streaming end-to-end with strict "no fallback after stream content sent" rule
- Request + attempt logs, statistics (Today / 7d / 30d), retention cleanup
- Admin TOTP 2FA, Argon2id passwords, recovery codes
- Immutable audit logs
- Consistent backup / restore (SQLite snapshot + checksum + schema validation)
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
npx latedev-router
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
