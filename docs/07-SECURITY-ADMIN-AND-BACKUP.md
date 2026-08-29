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

## Database download

A DB backup must be produced safely while SQLite is in use. Do not copy the main database file blindly while WAL writes are active.

Use SQLite's backup capability or another consistent snapshot technique.

Backup package should include enough metadata to validate:

- LateDev Router application version
- schema version
- creation timestamp
- checksum

Provider credentials remain encrypted inside the database. The external master key is not included in the backup.

Downloading a backup generates an audit event.

## Database restore/upload

Do not overwrite the live database immediately after file upload.

Required flow:

1. upload to a temporary location with strict size limit
2. validate file/package format
3. validate checksum
4. validate SQLite integrity
5. read schema/application metadata
6. reject unsupported future schema versions
7. create a backup of the currently live DB
8. enter a controlled maintenance/restore section where writes are blocked
9. atomically replace/restore
10. reopen database and verify migrations/integrity
11. if validation fails, rollback to the pre-restore copy
12. audit attempt and result

Never execute SQL text embedded in arbitrary upload formats. Restore only the supported database backup format.

The master key required to decrypt restored provider secrets must be supplied separately through deployment configuration.

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
