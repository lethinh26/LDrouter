# Compact Backup and Streaming Restore Design

## Purpose

Make database backup and restore practical for installations whose SQLite database is dominated by request, attempt, audit, or response-cache history. A compact backup preserves all gateway configuration and historical operational statistics while excluding forensic detail. Restore must upload directly to disk with client-visible progress instead of base64 JSON and whole-file browser/server buffering.

## Supersedes

This document refines the backup/export behavior in `docs/07-SECURITY-ADMIN-AND-BACKUP.md` and cache backup behavior in `docs/11-CACHING.md`. Existing safety requirements remain in force unless explicitly changed here.

## Decisions

- The default export is `compact`; `full` is an explicit forensic option.
- New backups use a binary `.ldb` container. Legacy `.ldb.json` backups remain restoreable.
- Compact backups retain aggregate statistics by UTC day, model, provider, and API key. They do not retain individual request, attempt, or audit records.
- Compact backups exclude gateway response-cache entries. Full backups retain them.
- Restore accepts a multipart file upload and writes it to a private temporary directory; it does not parse the backup body as JSON.
- The first release provides upload progress and cancellation, but not resumable chunk uploads. A network interruption requires choosing the file again.
- No new runtime dependency is added. The existing `@fastify/multipart`, Node streams/zlib/crypto, and SQLite support are sufficient.

## Non-goals

- Do not add off-host backup scheduling, cloud storage, or multi-part resumable uploads.
- Do not preserve request-level details, audit history, cache contents, latency percentiles, or exact recent failures in compact backups.
- Do not recalculate historical aggregates from raw logs at restore time.
- Do not weaken passphrase encryption, checksum, schema-version, SQLite integrity, rollback, maintenance, or secret-redaction protections.

## Backup container contract

New files have extension `.ldb` and binary layout:

1. A fixed magic/version prefix.
2. A length-prefixed UTF-8 JSON manifest.
3. A gzip-compressed standalone SQLite payload.

The manifest contains only:

```ts
interface BackupManifestV2 {
  format: 'latedev-backup';
  version: 2;
  profile: 'compact' | 'full';
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  compressedBytes: number;
  uncompressedBytes: number;
  checksum: string; // SHA-256 of exactly the compressed payload bytes
  keyEnvelope?: BackupMasterKeyEnvelope;
  excludedTables: string[];
  statistics: {
    granularity: 'daily';
    dimensions: Array<'model' | 'provider' | 'api_key'>;
    p95Available: false;
  };
}
```

The manifest never contains the plaintext master key, passphrase, provider credential, session cookie, API key, prompt, response, audit metadata, or cache content. `keyEnvelope` continues to passphrase-encrypt only the master key.

A v1 JSON envelope remains supported solely on restore. Its `payload` continues to be checksum-validated before decompression. New exports never create v1 files.

## Persisted statistics

Add three daily aggregate tables. All dates are UTC `YYYY-MM-DD`; relations use immutable IDs and permit historical references to deleted/disabled entities.

```ts
interface DailyModelStats {
  day: string;
  modelId: string | null;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  gatewayCacheHits: number;
  fallbackRequests: number;
  latencySuccessSumMs: number;
  latencySuccessCount: number;
  ttftSumMs: number;
  ttftCount: number;
}

interface DailyProviderStats {
  day: string;
  providerId: string;
  attempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  latencySuccessSumMs: number;
  latencySuccessCount: number;
}

interface DailyApiKeyStats {
  day: string;
  apiKeyId: string | null;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
```

The request persistence path updates these aggregates in the same SQLite transaction as `requests`, `request_attempts`, and quota rows. Existing raw rows remain the source of detail while they exist. The migration backfills aggregates once from existing `requests`/`request_attempts` before any compact export can be created.

Statistics endpoints use aggregates for day buckets and top rankings. If raw rows exist for a day, they are not double-counted. A single source-selection helper partitions requested ranges into aggregate-covered historic days and raw current/partial days. The response reports `percentilesAvailable: false` whenever any selected period is aggregate-only. Average latency and average TTFT remain calculable from sum/count; p95 latency and p95 TTFT are `null` for aggregate-only ranges.

Dashboard today uses raw request/attempt data, preserving current detailed failures and model health. After a compact restore, it starts collecting new raw detail normally; compacted historical data does not manufacture recent failures.

## Export profiles

### Compact (default)

The exporter obtains a consistent SQLite snapshot, opens a separate staging database, copies only rows needed for functional state and aggregate statistics, clears volatile/forensic data, runs `VACUUM`, then streams the compressed staging database into the v2 container.

Compact excludes:

- `requests`
- `request_attempts`
- `audit_logs`
- `response_cache`
- `admin_sessions`
- `csrf_tokens`
- `backups`

It retains all gateway configuration and entities, schema migrations/settings, admin credential/TOTP/recovery state, encrypted provider credentials, API key configuration, quota aggregates, and all daily statistics aggregates.

### Full forensic

The exporter produces a consistent SQLite snapshot and streams it into the v2 container without removing rows. It retains request/attempt/audit/cache data and is explicitly labeled sensitive in the UI.

Both profiles record an audit event after the response payload is successfully prepared. Audit metadata includes profile, byte count, checksum, and excluded table names only.

## Restore lifecycle

1. Require the existing admin auth + CSRF policy, except the existing first-run restore exemption.
2. Parse multipart fields: exactly one `backup` file and optional six-digit `passphrase`.
3. Stream the file to `<dataDir>/restore-tmp/<random>.part` with `0600` permissions. Reject a missing filename, unsupported extension/signature, malformed multipart body, or a file over the configured maximum before storage can exceed it.
4. The request abort/cancel handler closes and deletes the temporary file.
5. Read only the v2 header/manifest from disk, or parse legacy v1 only after its configured size check. Validate version, manifest fields, checksum, and the passphrase-protected master-key envelope.
6. Stream/decompress payload to a second private temporary SQLite file with a bounded uncompressed-size limit. Verify the SQLite header and run `PRAGMA integrity_check` in a read-only SQLite connection.
7. Verify the backup schema/app metadata; reject a future unsupported schema. Validate that compact tables have their required aggregate schema.
8. Create the existing consistent snapshot of the live DB, enter restore maintenance, close the in-process DB, atomically replace the live file, remove stale WAL/SHM files, reopen, run migrations, and verify the restored bootstrap row/schema.
9. If any post-swap validation fails, restore the live snapshot and the previous master-key override exactly as the current route does.
10. Recreate the current admin session/CSRF row, audit success/failure with metadata that contains no secrets, delete all temporary files, and reply only after the gateway is serving restored data.

## HTTP interfaces

```text
POST /api/admin/backup/create
Content-Type: application/json
{ "passphrase": "123456", "profile": "compact" | "full" }
→ application/octet-stream, attachment *.ldb

POST /api/admin/backup/restore
Content-Type: multipart/form-data
fields:
  backup: File
  passphrase: 6 digits when a key envelope exists
→ { "ok": true, "profile": "compact" | "full", "message": string }
```

The restore endpoint continues accepting the v1 JSON shape during the compatibility window. It does not accept SQL dumps or arbitrary archive formats.

Failure responses are `GatewayError` values with safe fixed messages. Relevant validation classes are: invalid format, size limit exceeded, checksum mismatch, decompression failure, invalid SQLite, integrity failure, unsupported future version/schema, invalid passphrase, live snapshot failure, atomic replace failure, and restore rollback failure. Internal filesystem paths and raw errors are never returned to the browser.

## Admin UI

Settings > Backup contains:

- Profile selector defaulting to Compact.
- Compact description: retains config and daily statistics by model/provider/API key; excludes requests, attempts, audit logs, and response cache.
- Full description: retains all forensic data and may be much larger/sensitive.
- Passphrase confirmation and download action.
- Restore file input accepting `.ldb` and legacy `.ldb.json`.
- A destructive confirmation dialog whose body names the selected file and states entire live DB replacement.
- A native XHR multipart upload progress bar with percent and uploaded/total MiB, plus Cancel while upload is active.
- Explicit sequential status: Uploading, Validating, Restoring, Complete or Failed. Validation/restore are indeterminate server phases after upload reaches 100%.
- Disabled controls during active restore; errors appear via the existing toast/error convention.

First-run Setup uses the same upload helper and accepts the same file types, without requiring an admin session. It shows upload progress and never calls `File.text()`.

## Capacity and cleanup

- Add a configuration default for maximum uploaded backup bytes. It is enforced against `Content-Length` when present and during stream writes when absent; the effective server value is returned by a small authenticated backup capability endpoint for UI preflight validation.
- Use `restore-tmp` under the existing data directory, mode `0700`; filenames come from `randomUUID`, never user filenames.
- Delete temporary upload, decompressed payload, and staging export files in `finally` paths. At startup, remove stale temporary files older than one day without touching live/snapshot backups.
- The browser shows a file-size warning before upload. It does not claim upload is resumable.

## Security and correctness invariants

- Never buffer a full backup in browser JS or server memory.
- Never log the passphrase, multipart body, file content, manifest key envelope, master key, secrets, or request content.
- Only replace the live DB after checksum, decryptability, SQLite integrity, and schema checks pass.
- Preserve current live DB and current master-key override on every failure.
- Compact restore keeps historical aggregates but not row-level observability. Full restore is the only profile that preserves that detail.
- Gateway response cache is absent after compact restore even when caching is enabled in restored settings.

## Acceptance criteria

- A compact export of a DB with large request/audit/cache data is materially smaller than the full export and contains no rows in excluded tables.
- A compact restore retains gateway configuration, encrypted providers, API-key configuration, quota usage, daily statistics, average latency/TTFT, and top model/provider/API-key rankings.
- Compact restore returns unavailable/null percentiles for aggregate-only history and does not invent request details/audit records/cache entries.
- Full backup/restore retains raw request/attempt/audit/cache rows.
- Legacy v1 JSON restore remains valid.
- 150 MiB uploads are streamed to disk with observable upload progress; abort cleans temporary files. The server does not call browser `File.text()` or parse a multipart payload as a JSON body.
- All existing restore safety acceptance criteria in `docs/10-TESTING-AND-ACCEPTANCE.md` continue to pass.
