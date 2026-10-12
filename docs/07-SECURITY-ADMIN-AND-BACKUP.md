# 07 — Security, Admin Authentication, and Backup

## Single-admin model

V1 has one administrator account. There is no RBAC or multi-user administration.

This simplification must not weaken basic security controls.

## First-run setup

On a fresh data directory/database:

1. application exposes only setup-safe admin routes plus health
2. first-run UI requires creation of admin credentials
3. strong password policy is enforced reasonably
4. once setup completes, the setup endpoint is permanently disabled for that database
5. setup state is transactional so two concurrent setup attempts cannot create conflicting admin accounts

Gateway compatibility endpoints may remain unavailable until setup is complete, or may operate only if API keys already exist after restore.

## Passwords

Hash administrator passwords with Argon2id. Never encrypt passwords reversibly.

Password change requires:

- current password
- current TOTP when 2FA is enabled
- successful audit record

Invalidate other admin sessions after password change.

## TOTP 2FA

Support:

- enable TOTP
- QR code setup
- manual secret entry fallback
- verification before activation
- recovery codes
- recovery codes displayed once
- regeneration of recovery codes
- disable TOTP only after password + current TOTP/recovery verification

Store the TOTP secret encrypted at rest. Store recovery codes hashed.

Sensitive TOTP administrative actions generate audit events.

## Admin sessions

Use secure HttpOnly cookie sessions.

Requirements:

- CSRF protection appropriate to the chosen session/API architecture
- SameSite policy
- Secure cookies under HTTPS
- session expiry
- login throttling/backoff
- logout invalidation
- no session token in localStorage

## Provider credentials

Upstream provider API keys and sensitive custom headers are encrypted at rest with authenticated encryption, preferably AES-256-GCM through a well-reviewed Node crypto API.

Encryption key:

- comes from `LATEDEV_MASTER_KEY` or an equivalent external secret source
- is never stored in SQLite
- is never returned by the UI/API
- is never logged

Use key-version metadata so future key rotation is possible, even if automated rotation is not required in v1.

### Master key behavior

Auto-generated master key: when `LATEDEV_MASTER_KEY` env is not set and the data directory is fresh, the setup process generates a 32-byte random base64 key and stores it in `<dataDir>/master.key` (mode 0600). This file is not included in database backups. When restoring a backup on another host, the original `master.key` file must also be deployed, or `LATEDEV_MASTER_KEY` must be set in the environment.

If encrypted secrets exist and the configured master key cannot decrypt them, startup should fail closed for provider use and produce a clear operator-safe error. Do not erase/re-encrypt data automatically.

## API key storage

Gateway keys (`ld-...`) are random high-entropy bearer tokens. Store a SHA-256 digest rather than plaintext. Provider keys are different: they must be recoverable for upstream calls, so encrypt them rather than hash them.

## Audit log

Audit administrative actions listed in the product scope.

Audit records must:

- exclude secrets
- record success/failure
- record target identifiers/snapshots
- include timestamp and effective client IP
- be immutable through normal UI CRUD

No bulk “clear audit log” action in v1.

## Database download (backup)

A DB backup must be produced safely while SQLite is in use. Do not copy the main database file blindly while WAL writes are active.

Use SQLite's backup capability or another consistent snapshot technique. The exporter takes a consistent `better-sqlite3` snapshot and streams it through gzip without ever buffering the database in memory.

### Container format (v2)

New backups use a binary container with the `.ldb` extension:

1. a fixed magic/version prefix (`LDRB` + version byte + 4-byte big-endian manifest length),
2. a length-prefixed UTF-8 JSON manifest,
3. a gzip-compressed standalone SQLite payload.

The manifest carries only: `format` (`latedev-backup`), `version` (2), `profile`, `appVersion`, `schemaVersion`, `createdAt`, `compressedBytes`, `uncompressedBytes`, `checksum` (SHA-256 of exactly the compressed payload bytes), the passphrase-protected `keyEnvelope`, `excludedTables`, and a `statistics` block (`granularity: daily`, dimensions `model`/`provider`/`api_key`, `p95Available: false`). It never contains the plaintext master key, passphrase, provider credential, session cookie, API key, prompt, response, audit metadata, or cache content. See `docs/superpowers/specs/2026-10-11-compact-backup-and-streaming-restore-design.md` for the exact layout.

### Profiles

- **Compact (default)** — retains all gateway configuration and entities, schema migrations/settings, admin credential/TOTP/recovery state, encrypted provider credentials, API-key configuration, quota aggregates, and daily statistics by model, provider, and API key. It excludes the forensic/volatile tables `requests`, `request_attempts`, `audit_logs`, the gateway response cache (`response_cache`), admin sessions (`admin_sessions`), csrf tokens (`csrf_tokens`), and `backups`. A compact backup is materially smaller and is the recommended routine download.
- **Full (forensic)** — keeps every row, including raw request/attempt/audit/cache content. It can be much larger and contains sensitive logged and cached content, so treat the file as confidential. It is explicitly labeled sensitive in the UI.

A compact backup **cannot restore individual request, attempt, or audit history**; only a full backup preserves that row-level detail. Aggregate statistics survive a compact restore, but per-request detail does not.

Both profiles record an audit event after the response payload is prepared. Audit metadata contains only profile, byte count, checksum, and excluded table names.

### Passphrase and key envelope

Before downloading, the admin enters a six-digit backup passphrase. The passphrase is not stored in SQLite, logs, or audit metadata. It derives a key used to encrypt the master key in the backup envelope. The **same six-digit passphrase** must be entered again during restore; without it the restored provider credentials cannot be decrypted. The backup database itself contains the admin username, Argon2id password hash, encrypted TOTP secret, and hashed recovery codes.

Provider credentials remain encrypted inside the database. The master key is included only in the passphrase-protected envelope, never as plaintext backup metadata.

Downloading a backup generates an audit event.

## Database restore/upload

Do not overwrite the live database immediately after file upload.

The restore endpoint accepts a streamed `multipart/form-data` body with exactly one `backup` file (`.ldb` or legacy `.ldb.json`) and an optional six-digit `passphrase` field, plus the legacy v1 JSON request body. The lifecycle is:

1. stream the upload to a private temporary file (`<dataDir>/restore-tmp`, directory mode `0700`, file mode `0600`) with strict size limit — the body is never buffered in memory;
2. validate the file/package format (v2 header/manifest, or legacy v1 envelope);
3. validate the checksum;
4. validate gzip decompression;
5. validate SQLite integrity (`PRAGMA integrity_check` on a read-only connection);
6. read schema/application metadata and reject unsupported future schema versions;
7. validate the passphrase-protected master-key envelope;
8. create a snapshot of the currently live DB;
9. enter a controlled maintenance/restore section where writes are blocked;
10. atomically replace/restore;
11. reopen database and verify migrations/integrity;
12. if any post-swap validation fails, roll back to the pre-restore copy and restore the previous master-key override;
13. audit attempt and result.

**Operator rollback guarantee:** the pre-restore snapshot is kept, and any failure after the swap rolls the live database back to it. A rollback failure is reported explicitly and requires a gateway restart; the gateway never stays on a broken database silently.

Never execute SQL text embedded in arbitrary upload formats. Restore only the supported database backup format.

For passphrase-protected backups, the master key is restored from the encrypted envelope. Legacy backups without a key envelope still require the master key from deployment configuration.

### Compatibility window

Legacy **v1 JSON** backups (`.ldb.json`, format `latedev-backup`, `version: 1`) remain restoreable during a compatibility window; their `payload` is checksum-validated before decompression. New exports never create v1 files. The restore endpoint does not accept SQL dumps or arbitrary archive formats.

### Upload limits and UI

The maximum uploaded backup size defaults to **256 MiB** and is configurable via `LATEDEV_MAX_BACKUP_UPLOAD_BYTES`. It is enforced against `Content-Length` when present and during stream writes when absent. An authenticated preflight endpoint `GET /api/admin/backup/capabilities` returns `{ maxUploadBytes }` so the UI can validate a file before upload. Over-limit uploads are rejected with HTTP **413**.

The Settings > Backup and first-run Setup UIs upload via a native XHR multipart request and show real upload progress (percent and uploaded/total bytes) with a **Cancel** button while the upload is active, followed by sequential Uploading → Validating → Restoring → Complete/Failed status. **Uploads are not resumable** — an interrupted upload must be restarted from the file picker. Temporary upload, decompressed payload, and staging files are removed on success, failure, and abort.

## Web security headers

Set sensible defaults:

- Content-Security-Policy compatible with the bundled UI
- X-Content-Type-Options
- frame-ancestors / anti-clickjacking policy
- Referrer-Policy
- HSTS only when deployment conditions make it correct

Avoid unsafe inline scripts where possible.

## Secret redaction tests

Automated tests must prove common secret forms are absent from:

- request logs
- error responses
- audit metadata
- console/server logs

Read next: `08-ADMIN-UI-UX.md`.
