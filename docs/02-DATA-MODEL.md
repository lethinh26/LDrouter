# 02 — Data Model

Use UUIDs or stable random IDs for internal relational keys. Human-visible slugs are mutable identifiers and must not be used as primary keys.

All timestamps are stored in UTC. The UI renders in the browser's local timezone.

## Tables

### `app_settings`

Key/value or typed singleton settings for:

- request log retention days
- maximum DB size guard
- request body logging mode
- trusted proxy policy
- setup state
- schema/application metadata

Do not store the master encryption key here.

### `admin_account`

Single-row account in v1:

- `id`
- `username`
- `password_hash`
- `totp_enabled`
- encrypted TOTP secret, nullable
- recovery-code hashes
- `created_at`
- `updated_at`
- `last_login_at`

Passwords: Argon2id with parameters chosen according to current library recommendations.

### `admin_sessions`

- `id`
- hashed session token or server-managed session identifier
- `created_at`
- `expires_at`
- `last_seen_at`
- optional IP/user-agent metadata

Use secure, HttpOnly, SameSite cookies for the browser admin UI. Set Secure when behind HTTPS.

### `providers`

- `id`
- `name`
- `slug` unique
- `type`: `openai | anthropic` (enforced by TypeScript and the SQLite CHECK constraint)
- `base_url`
- `encrypted_api_key`
- `encrypted_api_key_nonce` / required AEAD metadata
- `custom_headers_encrypted` or individually protected sensitive values
- `enabled`
- timeout fields
- retry settings
- circuit-breaker settings
- `created_at`
- `updated_at`

### `subscription_quota_accounts` (migration 0021)

Independent monitoring records for Codex and Claude Code subscription accounts,
not authentication or routing identities. Each row has a stable UUID, provider
kind, operator-selected name, optional SHA-256 fingerprint of an imported Codex
account identifier, one bounded normalized quota snapshot and UTC millisecond
creation/update timestamps. Names are unique per provider (SQLite NOCASE);
non-null identity fingerprints cannot be shared by two records of a provider.
Snapshots are observations with explicit source and observation time, not
enforceable limits. No upstream access/refresh token, session or raw provider
response is stored. The table has no relationship to the routing namespace,
models, API keys or provider connections. Codex client sync adds a distinct
observation source, `codex_client_sync`, using the same snapshot structure.
Its temporary per-record pairing digest and last upload time exist only in
process memory, bound to the current database epoch; no new schema or backup
state is needed.

### `models`

- `id`
- `provider_id`
- `upstream_model_id`
- `public_model_id` unique
- `display_name`
- `enabled`
- `upstream_available`
- capability fields or a validated JSON capability object
- `max_context_tokens` nullable
- `max_output_tokens` nullable
- `discovered_metadata_json`
- `created_at`
- `updated_at`
- `last_seen_upstream_at`

Unique constraint on `(provider_id, upstream_model_id)`.

### `combos`

- `id`
- `name`
- `slug` unique
- `public_model_id` unique; normalized name by default or `combo/<slug>` when a slug is explicitly supplied
- `combo_kind`: immutable `standard` (default) or `codex_native` (migration 0018)
- `mode`: `fallback`
- `enabled`
- `max_total_attempts`
- `max_request_duration_seconds` (nullable; additional overall combo deadline)
- fallback-trigger policy
- `fallback_on_total_timeout` (default true for new combos; migration 0012 copies the previous `fallback_on_connect_timeout` value for existing combos)
- `slow_response_fallback_enabled` (default true for standard, false for native Codex)
- `slow_response_threshold_seconds` (default 60)
- `slow_response_max_count` (default 3)
- `slow_response_generation` (increments on routing/latency-affecting configuration changes, fencing stale outcomes)
- `created_at`
- `updated_at`

### `combo_members`

- `id`
- `combo_id`
- `model_id`
- `position`
- `enabled`

Constraints:

- model must be physical
- no duplicate model in a combo
- position controls fallback ordering; the lowest position is tried first

### Adaptive combo runtime state (migration 0015)

Bounded state per membership and workload stores up to five timestamped successful latency samples,
consecutive absolute/relative slow counts, degradation/comparator, next recovery time, recovery
success count, owner token and expiry for recovery leases, and attempt ordering/generation fences.
Streaming TTFT and non-streaming completion latency are never compared across workloads.

Membership deletion cascades state deletion; a re-added model has a new member ID. Configuration
changes invalidate prior decisions/leases and fence in-flight writes. Migration 0015 resets old
unsegmented cooldown data while preserving combo configuration and all request/statistics history.
Active lease ownership does not survive a restart or restore.

### `model_aliases`

- `id`
- `alias` unique
- target kind: `model | combo`
- target ID
- `enabled`
- `created_at`
- `updated_at`

Alias resolution must be exactly one hop in v1. Do not allow alias-to-alias chains.

### `api_keys`

- `id`
- `name`
- `key_prefix`
- `key_digest` unique
- `enabled`
- `expires_at` nullable
- request-per-minute limit nullable
- token-per-minute limit nullable
- daily token limit nullable
- monthly token limit nullable
- max concurrent requests nullable
- max output tokens per request nullable
- `created_at`
- `updated_at`
- `last_used_at`

Do not store plaintext gateway API keys.

### `api_key_model_permissions`

Represent explicit allow-list entries. Target may be:

- physical model
- combo
- alias if aliases are intentionally exposed through ACL

Prefer normalizing to the resolved public IDs at evaluation time while preserving stable foreign keys where possible.

A key with no allowed models should be denied access to all models, unless the UI explicitly supports an “Allow all current and future models” boolean. If that boolean is implemented, store it explicitly; do not infer it from an empty list.

### `api_key_ip_rules`

- `id`
- `api_key_id`
- `mode`: `allow | deny`
- `cidr`
- `created_at`

Support IPv4 and IPv6 CIDR. A single IP is normalized to `/32` or `/128` internally if convenient.

Evaluation order:

1. deny match => deny
2. if one or more allow rules exist and IP does not match any => deny
3. otherwise allow

### `requests`

One row per gateway client request:

- `id` (gateway request ID; indexed/unique)
- `created_at`
- `completed_at`
- `api_key_id` nullable only for relevant internal/admin diagnostics
- `key_prefix_snapshot`
- `client_ip`
- `protocol`: `openai | anthropic`
- `endpoint`
- `requested_model`
- `resolved_target_kind`
- `resolved_target_id`
- `final_model_id` nullable
- `streaming`
- final HTTP status
- success boolean
- total latency ms
- TTFT ms nullable
- input tokens
- output tokens
- cache read tokens
- cache write tokens
- reasoning tokens
- total tokens
- attempts_count
- `error_type` nullable
- sanitized `error_message` nullable
- optional request payload snapshot according to privacy setting
- optional response payload snapshot according to privacy setting

Do not store monetary cost.

### `request_attempts`

One row per upstream attempt:

- `id`
- `request_id`
- `attempt_number`
- `provider_id`
- `model_id`
- `started_at`
- `completed_at`
- status code nullable
- success
- latency ms
- TTFT ms nullable
- input/output/cache/reasoning token fields
- `stream_started`
- `partial_response`
- sanitized upstream error type/message/body excerpt
- upstream request ID if returned

Provider/model IDs in request and attempt history are historical identifiers, deliberately not foreign keys to active provider/model configuration. Historical requests and daily aggregates survive provider removal; display uses the retained ID if an active label no longer exists.

A request may succeed while one or more earlier attempts failed.

### `audit_logs`

- `id`
- `created_at`
- `action`
- `actor` (`admin` in v1)
- `ip`
- target type/id/name snapshot
- success boolean
- sanitized metadata JSON

Audit logs are not deleted by request-log retention.

## Indexes

At minimum design indexes for:

- requests by created time
- requests by success/status
- requests by API key
- requests by final model
- requests by requested model
- attempts by request ID
- attempts by provider/model + created time
- audit logs by created time/action
- API-key digest lookup
- provider slug
- model public ID
- combo public ID
- alias

## Deletion behavior

Provider/model deletion in the UI should normally be soft/blocked when historical references exist. Prefer `enabled=false` or preserve a tombstoned row so request history remains meaningful.

When an API key is revoked/deleted, retain request history and the key prefix/name snapshot.

## Migration requirements

- Every schema change must be represented by a migration.
- Startup may apply pending migrations automatically if safe, or fail with a clear migration error; choose one documented strategy and test it.
- Backups record schema version.
- Restore refuses an incompatible future schema version rather than attempting unsafe downgrade.
- Migration 0014 removes retired provider configurations, account credentials and account-specific attempt columns, cleans their dependent configuration, disables combos that lose all members, and preserves all generic request/attempt/audit rows and daily aggregates. Existing migration files remain immutable.

Read next: `03-PROTOCOL-COMPATIBILITY.md`.
