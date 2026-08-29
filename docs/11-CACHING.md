# 11 — Caching

LateDev Router must distinguish two different concepts that are often both called “cache.” They must not be conflated in logs, settings, or statistics.

## 1. Provider prompt caching

Some upstream providers expose native prompt/context caching and report cache-related token usage.

LateDev Router should:

- preserve supported provider cache-control semantics when the client/upstream protocols can map them safely
- normalize provider-reported cache usage into `cache_read_tokens` and `cache_write_tokens` when available
- never invent cache token counts
- expose these token fields in request/attempt logs and statistics
- treat unsupported cache directives as an explicit compatibility decision rather than silently claiming they were honored

Provider prompt caching is an upstream feature and does **not** mean the gateway stores the response.

## 2. Gateway response cache

Implement an optional exact-request response cache inside LateDev Router.

### Defaults

- globally disabled by default
- disabled for a key/model unless effective policy explicitly enables it
- metadata UI must clearly distinguish “Gateway response cache” from “Provider prompt cache”

This conservative default prevents accidental retention of sensitive prompts/responses.

### V1 scope

To keep the application lightweight and behavior predictable:

- cache only successful, non-streaming generation responses in v1
- streaming requests bypass gateway response cache
- do not cache failed or partial responses
- do not cache admin APIs, model listings, health endpoints, or token-count requests unless separately justified
- tool-call responses should be non-cacheable by default; only allow them if the implementation has an explicit safe policy

### Storage

Use SQLite. Do not add Redis.

Suggested `response_cache` fields:

- `id`
- `cache_key` unique
- target kind/id
- target/config revision or equivalent invalidation discriminator
- canonical response payload
- protocol-independent usage metadata where useful
- created time
- expiry time
- last-hit time
- hit count
- approximate stored bytes

Consider compression only if it clearly reduces size without complicating reliability.

### Cache key

The key must be derived from a deterministic canonical serialization of every request field that can affect output, including at least:

- requested/resolved target identity
- combo/alias configuration revision where applicable
- canonical messages/content
- system instructions
- tools/tool schemas
- generation parameters
- response-format/structured-output configuration
- reasoning/thinking configuration
- other behavior-affecting supported fields

Never key only on prompt text.

Use a cryptographic hash of the canonical serialized key material. Do not store secrets in the cache-key string.

### Combo behavior

A cached response for a combo can otherwise become surprising after combo membership changes. Therefore combo configuration changes must invalidate or version-bust cached entries for that combo.

The same applies to aliases that are retargeted.

### Policy

Support effective cache policy with at least:

- global gateway-cache enable/disable
- default TTL
- maximum cache storage size
- per physical model/combo enable override
- per API key enable/disable override

Choose and document deterministic precedence. Recommended secure precedence:

```text
Global OFF => always off
Key explicitly OFF => off
Target explicitly OFF => off
Otherwise both key/target policy must permit caching
```

Do not let “unspecified” accidentally enable caching.

### Invalidation and cleanup

Support:

- TTL expiration
- max-size eviction, oldest/LRU-style policy acceptable
- manual Clear Gateway Cache action in Settings
- invalidation/version bump on target behavior changes

Cache cleanup must be chunked/bounded to avoid long SQLite locks.

### Privacy

Gateway response cache stores content even when request-content logging is metadata-only. The Settings UI must explicitly explain this distinction.

When gateway response caching is enabled, treat cached content as sensitive application data.

A database backup includes response-cache entries unless the implementation deliberately excludes them through a consistent snapshot/export format. Document the chosen behavior.

### Logs and statistics

Record separately:

- `gateway_cache_hit` boolean
- provider cache read/write token counts

A gateway cache hit should produce zero upstream attempts and be clearly identified in the request detail UI.

Statistics should include gateway cache hit rate in addition to provider cache token totals.

No monetary cost computation is required.

Read next: `12-IMPLEMENTATION-ORDER.md`.
