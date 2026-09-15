# Native Codex OAuth JSON Import Design

**Status:** Proposed for review
**Date:** 2026-09-12
**Scope:** Native Codex OAuth account support and JSON import in LateDev Router

## Goal

Integrate Codex OAuth accounts directly into LateDev Router so an administrator can import one or many Codex credential JSON records through the authenticated admin UI/API, route requests across imported accounts, refresh credentials safely, and remove the external `import-codex-cleaned/` intermediary.

## Non-goals

- Do not import or write directly to another router's database.
- Do not modify `~/.codex/config.toml` or `~/.codex/auth.json` during import.
- Do not add support for other OAuth providers in this feature.
- Do not expose raw access, refresh, or ID tokens in API responses, UI, logs, audit metadata, request logs, backups, or error messages.
- Do not add ZIP support in the first implementation unless the existing multipart path cannot satisfy the accepted input workflow. JSON, JSON arrays, JSONL, and supported wrapper objects are the initial contract.
- Do not replace the existing encrypted provider API-key model; Codex credentials have a separate account pool.

## Existing constraints

LateDev Router is a single-process Fastify + React/Vite + SQLite/WAL application. Provider API credentials are encrypted with AES-256-GCM using the existing master-key mechanism. Model routing already supports capability filtering, fallback, weighted round robin, circuit breakers, request-attempt logging, streaming, and admin-session authentication. Every schema change must use a migration.

## External behavior being matched

The implementation follows the useful behavior observed in 9router's Codex bulk-import flows:

- Accept a single object, an array, or an `accounts` wrapper.
- Unwrap Codex CLI `auth.json` records containing `tokens`.
- Decode JWT payload claims to recover non-secret account metadata; decoding is not signature verification.
- Derive expiry from explicit expiry fields, token claims, or a bounded fallback.
- Process records independently and return per-record outcomes without returning secrets.
- Re-import updates an existing account rather than creating a duplicate.
- Account identity must use ChatGPT/workspace account identity when available; email alone must not merge unrelated Codex accounts.

## Architecture

### Provider type

Extend the provider type from `openai | anthropic` to `openai | anthropic | codex`.

A Codex provider is a logical upstream configuration and model pool. It does not store a usable API key in `providers.encrypted_api_key`; its credentials are the rows in `codex_accounts`.

The existing public physical model ID format remains `<provider-slug>/<upstream-model-id>`. Codex models therefore use the configured Codex provider slug, not a hardcoded `cx/` prefix. This avoids a second public-ID convention inside LDrouter.

### Codex account storage

Add a `codex_accounts` table with the following fields:

- `id` — internal UUID primary key.
- `provider_id` — foreign key to `providers`, restricted on delete.
- `email` — nullable display metadata.
- `workspace_id` — nullable account/workspace identity.
- `chatgpt_account_id` — nullable ChatGPT account identity retained separately when supplied.
- `plan_type` — nullable plan metadata such as `free`, `plus`, `pro`, or `team`.
- `encrypted_access_token`, `access_token_nonce`, `access_token_version`.
- `encrypted_refresh_token`, `refresh_token_nonce`, `refresh_token_version`.
- `encrypted_id_token`, `id_token_nonce`, `id_token_version`, nullable.
- `token_expires_at` — normalized UTC timestamp.
- `last_refresh_at` — nullable UTC timestamp.
- `auth_method` — `oauth` or `access_token` only if the existing provider contract needs raw-token imports; the first UI flow imports OAuth records.
- `enabled`.
- `health_state` — `healthy | degraded | down | unknown`.
- `last_error` — sanitized error category/message only.
- `consecutive_failures`.
- `priority` — deterministic fallback ordering.
- `created_at`, `updated_at`.

Indexes and constraints:

- Index `(provider_id, enabled, priority)`.
- Index `(provider_id, email)`.
- Index `(provider_id, chatgpt_account_id)`.
- No uniqueness constraint on email because one email may have multiple workspaces/accounts.
- Account deletion is soft-disable when request history or model routing references require retention.

Add nullable `codex_account_id` to `request_attempts` so every upstream attempt can identify the selected account without storing credentials. Existing `provider_id` and `model_id` remain authoritative for provider/model reporting.

### Credential encryption

Reuse `encryptSecret`, `decryptSecret`, and the current master-key versioning. Each token is encrypted independently with a fresh nonce. A missing optional token remains null; a required access token is rejected during import.

The repository layer must never return decrypted credentials to route handlers unless a provider call explicitly requests them. Public account summaries contain only masked IDs and metadata.

## Import normalization

Create a pure TypeScript module, preferably `src/server/providers/codex-import.ts`, with no database, filesystem, network, or logging side effects.

Accepted root shapes:

1. One flat object.
2. JSON array of objects.
3. `{ "accounts": [...] }`.
4. Codex CLI auth object with `{ "tokens": { ... } }`.
5. JSONL where every non-empty line is one JSON record.

Accepted token aliases:

- `access_token` or `accessToken` — required.
- `refresh_token` or `refreshToken` — required for OAuth import.
- `id_token` or `idToken` — optional but preferred.

Metadata resolution order:

- Email: OpenAI JWT profile claim, then top-level `email`.
- ChatGPT account ID: OpenAI JWT auth claim, then `chatgpt_account_id`, then `account_id`.
- Workspace ID: explicit `workspace_id`, `workspaceId`, or equivalent provider metadata.
- Plan: OpenAI JWT auth claim, then top-level `chatgpt_plan_type`/`plan_type`.
- Expiry: explicit `expired`/`expires_at`/`expiresAt`, then JWT `exp`, then `expires_in`, then `last_refresh + 10 days`, then `now + 10 days`.

Validation rules:

- Input must be an object after unwrapping.
- Access and refresh tokens must be non-empty strings after BOM/whitespace cleanup.
- Token length must have a reasonable upper bound to prevent oversized payload abuse.
- Explicit expiry must parse to a valid UTC timestamp.
- A record without email and without any account identity remains importable only if the administrator can distinguish it by a generated masked label; the preview must mark that identity is incomplete. The implementation should prefer rejecting such records if the existing Codex upstream requires account identity.
- Server-controlled fields (`id`, provider, timestamps, enabled, priority, health) are ignored from input.

The normalizer returns an internal record containing secret values only inside the server-side import pipeline. Preview/result DTOs are separate types and cannot serialize those fields.

## Account identity and upsert

Use this identity order for an incoming record:

1. Same provider + same `chatgpt_account_id` or workspace/account identity.
2. Same provider + same `(email, chatgpt_account_id)` when both are present.
3. Same provider + same access-token digest only as a last-resort migration/dedup key.

Do not merge Codex OAuth accounts by email alone when the account/workspace identity is absent on either side.

On an upsert:

- Preserve existing account `id` and `created_at`.
- Replace access/refresh/ID tokens atomically and encrypt them before persistence.
- Preserve manually configured `enabled` state unless the import explicitly supports an administrator-selected activation option.
- Reset stale token error state and set health to `unknown` or `healthy` according to the selected policy; do not claim token validity without an upstream check.
- Update metadata and `updated_at`.
- New accounts receive `priority = max(provider Codex priority) + 1`.

## Admin API

All routes require the existing admin session and CSRF protections.

### `POST /api/admin/codex/accounts/preview`

Accept either JSON or multipart upload, subject to a strict request-size limit. The initial implementation must support JSON body text and multiple JSON files from the UI. The route parses and normalizes without writing to the database or making upstream calls.

Response shape:

```json
{
  "records": [
    {
      "index": 0,
      "source": "accounts.json#1",
      "valid": true,
      "email": "user@example.com",
      "accountIdMasked": "b346c65a…7784",
      "workspaceIdMasked": null,
      "planType": "plus",
      "expiresAt": "2026-10-01T00:00:00.000Z",
      "duplicateOf": null,
      "error": null
    }
  ],
  "validCount": 1,
  "invalidCount": 0
}
```

The response must never contain any token field, token tail, or original raw JSON.

### `POST /api/admin/codex/accounts/import`

Accept the same normalized input contract plus the selected record indexes from preview if the UI needs to exclude invalid records. Re-parse and validate on the server; never trust preview state from the client. Upsert each valid record in a transaction, returning only counts and per-record safe metadata.

Response shape:

```json
{
  "added": 1,
  "updated": 2,
  "skipped": 0,
  "failed": 1,
  "results": [
    { "index": 0, "status": "added", "email": "user@example.com", "accountIdMasked": "…" },
    { "index": 1, "status": "failed", "error": "Missing refresh token" }
  ]
}
```

Audit one event for the batch and sanitized per-record failure information. Do not include source JSON, token values, token hashes, or decrypted credential values in audit metadata.

### Account administration

Add authenticated routes for:

- `GET /api/admin/codex/accounts` — safe summaries only.
- `PATCH /api/admin/codex/accounts/:id` — enabled/disabled and safe metadata overrides where supported.
- `DELETE /api/admin/codex/accounts/:id` — soft-disable when referenced.
- `POST /api/admin/codex/accounts/:id/test` — upstream credential test without returning tokens.

## Codex provider adapter

Add a Codex-specific adapter rather than forcing Codex through the generic OpenAI API-key path.

Responsibilities:

- Build the Codex upstream URL and required headers.
- Select an eligible account using fallback/weighted state already used by routing, with account-level health filtering.
- Decrypt credentials only immediately before the upstream call.
- Proactively refresh when the token is expired or inside the configured refresh lead time.
- Use a single-flight lock keyed by account ID so concurrent requests cannot rotate one refresh token multiple times.
- Persist rotated access/refresh/ID tokens and expiry atomically.
- On a 401/403, refresh once and retry once before classifying the account failure.
- Mark only upstream-health failures against the account circuit/health state; client validation errors must not poison the account.
- Strip unsupported Codex request fields and map to the existing canonical protocol model.
- Support streaming without buffering the complete response.

The adapter must expose safe account selection and outcome metadata to the gateway runner. It must not expose plaintext credentials outside the narrow upstream-call function.

## Routing and model discovery

- Codex models are discovered through the Codex-specific model endpoint or configured static fallback if the endpoint is unavailable.
- Discovery remains selective: fetch does not import models until the admin confirms selection.
- Codex model capabilities must remain explicit/unknown when not proven.
- Candidate filtering must reject unsupported streaming, tools, reasoning, structured output, or image requirements before an upstream call.
- Direct physical model requests stay direct. Account fallback is internal to the selected Codex provider; unrelated models are not substituted.
- Combo fallback behavior remains unchanged. A Codex account attempt may fail over to another account only before semantic stream commitment.

## UI

Extend the Providers page with a Codex-specific account management panel. The panel appears when provider type is `codex` and uses existing shadcn/ui components.

Required flow:

1. Administrator opens Codex provider.
2. Clicks `Import JSON`.
3. Selects one or more `.json` files or pastes JSON/JSONL.
4. Clicks `Preview`.
5. Reviews valid, duplicate, and invalid records.
6. Removes/ignores invalid records if desired.
7. Clicks `Import selected`.
8. Sees added/updated/failed result summary.

Account table fields:

- email
- masked account/workspace ID
- plan
- token expiry
- health
- enabled
- last refresh
- safe actions

The UI must not display raw tokens, token tails, or full credential JSON. Mutations use toast feedback and audit-backed request IDs where applicable.

## Error handling and privacy

Canonical errors:

- invalid request for malformed input
- authentication error for failed upstream credential validation
- upstream unavailable for connection failures
- timeout for refresh/upstream timeout
- gateway error for encryption/master-key failure

All errors are sanitized through the existing error/redaction path. Import parsing errors identify record index/source and a safe reason only.

File limits:

- Maximum JSON request/import size must be configurable or use a documented conservative default.
- Maximum records per batch must be bounded.
- Parser must reject excessive nesting/oversized strings where practical.

## Migrations and backup

Add one migration for the Codex account table and `request_attempts.codex_account_id`. Update schema metadata/version constants. Backup and restore automatically include the new table because it is part of the SQLite snapshot; integrity validation must run against the migrated schema. Restore must continue to refuse future schema versions.

No plaintext credential export is added. Existing encrypted database backup behavior remains authoritative.

## Testing strategy

### Unit tests

Create fixtures based on the temporary `import-codex-cleaned/` examples without copying real secrets:

- flat object
- Codex CLI `tokens` wrapper
- `accounts` wrapper
- JSON array
- JSONL
- BOM and whitespace
- malformed JSON
- missing access token
- missing refresh token
- JWT email/account/plan extraction
- explicit expiry, JWT expiry, and fallback expiry
- identity deduplication with same email/different workspace
- token redaction from preview/result objects
- encrypted credential round trip

### Integration tests

- Empty-database migration creates the new schema.
- Preview does not mutate account/model/provider tables.
- Import creates encrypted credentials and safe summaries.
- Re-import updates in place and preserves account ID/created timestamp.
- One invalid record does not erase or invalidate valid records.
- Admin auth/CSRF is enforced.
- Master-key mismatch fails closed without deleting credentials.
- Mock Codex upstream tests discovery, refresh, rotated refresh token persistence, 401 refresh retry, non-streaming, streaming, and account fallback.
- Request attempts include the selected Codex account ID but no secrets.
- Backup/restore preserves encrypted Codex accounts.

### Acceptance commands

Run after implementation:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
docker build -t latedev-router:test .
docker compose config
```

## Rollout and compatibility

- Existing `openai` and `anthropic` providers remain unchanged for API-key use.
- Existing public model IDs remain valid.
- Existing databases migrate forward without requiring Codex data.
- Codex functionality is unavailable until a `codex` provider and at least one imported account exist.
- The temporary `import-codex-cleaned/` folder remains untouched during implementation and can be deleted by the user after the native feature is verified.

## Open implementation choices resolved by this design

- Codex account pool is a dedicated table, not one provider per account.
- Import is admin-authenticated API/UI, not direct SQLite mutation.
- Codex model IDs use the normal provider slug format.
- Import does not write Codex CLI configuration files.
- ZIP is deferred from the first implementation unless explicitly added during implementation after validating multipart limits.
- Email-only deduplication is forbidden for Codex OAuth accounts.
