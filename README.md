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
- Native Codex OAuth account pools with encrypted JSON/JSONL import, refresh/rotation, account-aware routing, and admin management
- Native Qoder account pools driven by personal access tokens, with encrypted storage, live model-catalog discovery, and account-aware routing

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

### Codex OAuth setup

1. Set `LATEDEV_MASTER_KEY` before creating or importing credentials. Use a strong random base64 key; it encrypts Codex access, refresh, and ID tokens at rest.
2. In **Providers**, create a provider with type **Codex**. Codex providers do not use the generic API-key field.
3. Open the Codex account panel and import a redacted copy of a Codex OAuth `auth.json`, a JSON array, an `{ "accounts": [...] }` wrapper, or JSONL with one record per line. Records may contain a `tokens` object with access/refresh/ID tokens. For example:

   `{ "accountId": "acct-…masked", "email": "admin@example.invalid", "tokens": { "accessToken": "[REDACTED]", "refreshToken": "[REDACTED]" } }`

   JSONL stores one similarly redacted object per line; an array uses the same records: `[ { "accountId": "acct-…masked", "tokens": { "accessToken": "[REDACTED]" } } ]`.

   Alternatively, use **Connect Codex** to authorize a ChatGPT account in the browser. The dialog shows the Codex CLI PKCE authorize URL, waits for the loopback callback, and also accepts a pasted callback URL or bare authorization code. The PKCE verifier and the authorization code stay server-side and never appear in the UI. The Codex CLI callback (`http://localhost:1455/auth/callback`) is captured by `GET /oauth/codex/callback`; because browsers block that cross-origin redirect, paste the address bar URL into step 2 when the auto-capture page fails to load.
4. Review the preview and import only the records you want. Account/workspace identity is preferred for deduplication; email alone never merges unrelated accounts. Re-importing the same identity updates its encrypted tokens while preserving its enabled state.

Raw tokens are accepted only by the authenticated import pipeline and are never returned in previews, API responses, UI state, audit logs, request logs, errors, or database backups. JWT claims are decoded for metadata only; token signatures are not verified locally. Tokens are refreshed proactively near expiry and once after an upstream 401/403, with rotated values persisted atomically.

The import endpoint requires the normal admin session and CSRF token (`x-csrf-token`) for mutations, including multipart uploads. Use HTTPS for remote administration and protect the master key like any encryption key. Back up the SQLite data directory consistently; restoring encrypted credentials requires the matching master key, otherwise re-save/re-import credentials after restore.

ZIP upload and automatic Codex CLI config-file generation/mutation are not included in this release. LateDev Router does not modify Codex CLI files.

The account panel shows the 5-hour and weekly quota windows with reset countdowns, per-account and bulk usage refresh, weekly reset credits, an opt-in 5-hour window auto-start, and a **Test** control that probes the upstream account without exposing tokens. Routing order is set by dragging rows; the saved order is the fallback order the router uses. **Delete** is permanent and erases the stored encrypted credentials — past request logs are kept but lose the account reference.

**A quota-exhausted account leaves the pool on its own.** When an account refuses for quota reasons — Codex `429 The usage limit has been reached`, or Qoder `out of credits` — it is marked `down` *and disabled*, so the very next request picks a different account in the pool rather than retrying the spent one. This applies to direct `codex/...` and `qoder/...` models too, not only combos. Re-enable the account in the panel once its window resets. Both Codex usage and Qoder credits are also refreshed in the background after a successful request (throttled, and never on the response path), so the panel figures track real usage without pressing **Refresh**.

### Qoder setup

Qoder providers use a personal access token (PAT) instead of an API key. Create one at `https://qoder.com/account/integrations`; it starts with `pt-`.

1. Set `LATEDEV_MASTER_KEY` before adding a token. It encrypts both the PAT and the derived job token at rest.
2. In **Providers**, click **Add Qoder**. The server creates the provider with its fixed endpoint — there is no base URL or API key to fill in.
3. In the Qoder account panel, click **Add token** and paste the PAT, or **Import tokens** to paste/upload a list: one token per line, a JSON array of strings, an `{ "accounts": [...] }` wrapper, or JSONL of strings/objects (`token`, `pt_token`, `personal_token`, `access_token`; optional `label`/`name`/`email`). Only `pt-` tokens are accepted — a `dt-` device token or a `jt-` job token is rejected with that reason rather than failing later upstream.

Adding a token exchanges it immediately for a short-lived job token and fetches the model list; inference then runs against `api2.qoder.sh` using that job token. The PAT is kept so a new job token can always be minted — the operator never has to touch it again. If the token works but the model list cannot be fetched, the account is still stored (health `unknown`, with the error recorded) so you can retry with **Catalog**.

Because the gateway serves model discovery from that live catalog, a new account has no routable models until its first successful fetch. Use **Import models** on the provider row to pull the discovered models in.

**Operational caveat:** a revoked or expired PAT is a durable failure. The account is marked `down` with "personal access token rejected — replace it" and routing skips it; nothing retries it forever. Re-add the account with a fresh token. Deleting an account is permanent and erases the stored encrypted PAT — past request logs are kept but lose the account reference.

The panel shows the masked user id, job-token expiry, when the catalog was last fetched, health, and an enabled toggle. Routing order is set by dragging rows, exactly as with Codex.

### Qoder usage, Credits and promotions

Qoder does not meter models in tokens: its chat stream carries no usage block at all, so request logs
show zero tokens for every Qoder model and the panel's **Credits** column is the account's real
usage. It is read from Qoder's quota API (`GET /api/v2/quota/usage` on `openapi.qoder.sh`) and shows
the plan / add-on / org buckets, the percentage used, and whether the account is exhausted.

**Credits and free models are different things, and the panel shows both.** Qoder keeps promoting a
model — currently `qmodel_38max`, the Qwen3.8-Max route — by marking its catalog entry `is_free`.
Such a model spends no Credits, so an account at **zero Credits** still answers on it while every
other model returns an envelope `403 code 112` with a `pricingUrl`. That pairing is what makes an
"out of credits" account look partly broken: the panel labels the column **No plan credits** next to
**Free now: qmodel_38max** so the contradiction is visible instead of looking like a router fault.

There is an upstream edge worth knowing when reading logs: a quota refusal arrives as **HTTP 200**
with a `403` envelope inside the streamed body, so it is not an HTTP error at the transport layer.

Use **Refresh credits** to re-read the snapshot for every account. It deliberately reuses the live
`job token` instead of exchanging the PAT again — a fresh exchange invalidates the token a
concurrent request may be using.

**Test** sends one real message, because a catalog probe cannot see a quota refusal. It picks a
promotion-covered model when the account has one, so testing never spends Credits.

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
