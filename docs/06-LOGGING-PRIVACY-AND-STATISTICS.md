# 06 — Logging, Privacy, and Statistics

## Request logging model

Request history has two levels:

```text
Gateway Request
  ├─ Attempt 1
  ├─ Attempt 2
  └─ Attempt N
```

A final successful request can contain failed earlier attempts.

## Request list UI

Required columns/compact fields:

- status badge
- time
- request ID
- requested model
- final model
- API key display name/prefix
- tokens (input/output/cache as compact summary)
- latency
- HTTP status

Expandable/detail area:

- all token categories
- protocol and endpoint
- client IP
- streaming flag
- TTFT
- attempts
- sanitized request error
- content payload if logging policy permits

Attempt accordion/table:

- attempt number
- provider
- physical model
- success/failure
- status
- latency/TTFT
- token usage
- stream-started/partial flags
- sanitized upstream error
- upstream request ID if safe

## Filters

Support at minimum:

- date range
- success/failure
- HTTP status
- provider
- physical model
- requested model/combo/alias
- API key
- IP
- request ID
- streaming

Server-side pagination is required. Do not load all logs into the browser.

## Error display

Failed rows have a dropdown/accordion that shows the returned/sanitized error. Preserve enough upstream detail for troubleshooting, but redact:

- Authorization headers
- Anthropic/OpenAI API-key headers
- gateway `ld-` keys
- provider secret values
- cookies/session tokens
- encryption/master key values
- known custom-header secrets

Implement recursive structured redaction plus defensive string redaction for log/error messages.

## Request content privacy

Settings enum:

- `off`: no request or response content saved
- `metadata`: metadata only; same effect for content persistence, but explicit UI wording may explain metadata retention
- `prompt`: save sanitized request content only
- `prompt_and_response`: save sanitized request and response content

Default: **metadata only**.

For streams, if response-content logging is enabled, collecting a sanitized copy is allowed but must not block client streaming. Respect configured size caps and mark truncated content.

## Retention

Settings:

- 1 day
- 7 days
- 30 days
- 90 days
- custom number of days
- forever

Default: 30 days unless a more conservative product choice is documented.

Cleanup should run periodically in-process and also be triggerable manually from Settings.

Use chunked deletion to avoid long DB locks.

Audit logs are excluded from this cleanup.

## Database size guard

Allow a configured maximum data/database size. When exceeded:

1. attempt request-log cleanup according to retention policy
2. if still above threshold, remove oldest eligible request logs in bounded batches
3. never delete audit logs automatically under the request-log policy
4. expose a warning in the UI

Do not crash a live request just because the cleanup worker could not immediately shrink SQLite files.

## Statistics

Date presets:

- Today
- 7 days
- 30 days

All date calculations must have explicit timezone semantics. UI may submit browser timezone so “Today” means the admin's local day; backend must avoid ambiguous local-time storage.

Summary cards:

- requests
- success rate
- failed requests
- total tokens
- input tokens
- output tokens
- cache tokens
- reasoning tokens where available
- average latency
- p95 latency
- average/p95 TTFT where available
- cache hit rate
- fallback rate

Charts:

- request count by time bucket
- token count by time bucket
- errors by time bucket

Rankings:

- top 10 models by requests
- top API keys by requests/tokens
- top providers by requests
- high-error models/providers with minimum sample threshold

No cost metrics.

## Performance

Statistics queries must be indexed and bounded. If raw aggregation becomes too slow, add lightweight daily/hourly aggregate tables through a migration; do not introduce an external analytics service in v1.

Read next: `07-SECURITY-ADMIN-AND-BACKUP.md`.
