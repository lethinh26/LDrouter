# 2026-08-28 — Auto-gen master key, re-readable/settable API keys, brand logo

## Context

LateDev Router is a greenfield spec pack already implemented in this repo. Three
production adjustments were requested against the finished build:

1. If `LATEDEV_MASTER_KEY` has not been set up for a data dir, auto-generate one.
2. Gateway API keys must be readable back from the DB at any time (copyable after
   the modal closes), support an optional custom key value on creation, and be
   stored encrypted at rest.
3. Replace the placeholder "L" branding with the real `latedev.svg` logo already
   present in the repo root, using favicon/logo assets sized for the UI.

All decisions below were agreed with the user during brainstorming.

## Decision log

| # | Question | Decision |
|---|----------|----------|
| 1 | Where to persist an auto-generated master key so restarts keep working | Write a 32-byte `master.key` file in the data dir (0600). Env var still wins when set. |
| 2 | How to let users copy an API key after the modal closes | Store the secret encrypted at rest (AES-256-GCM with the master key); expose a `secret` field on the admin GET/list route; Copy + Eye actions per row. |
| 3 | Recoverability vs. plaintext | Encrypt-at-rest (still fully recoverable, doesn't turn the DB into a plaintext-secret store). |
| 4 | Custom key entry rules | Use the submitted string verbatim — no prefix injection, no min-length rewrite. Empty = server auto-generates `ld-<base64url32>`. |
| 5 | Logo handling | Extract the 1024² embedded PNG and produce small `favicon.png` (≈48px) + `logo.png` (≈128px); point favicon + UI `<img>` at them. Keep the 1.2 MB root file untouched. |

---

## 1. Auto-generated master key

### Behavior

`loadConfig()` master-key resolution order:

1. `LATEDEV_MASTER_KEY` env / `--master-key` CLI arg if present (unchanged).
2. `<dataDir>/master.key` file if it exists → its contents used as the key string.
3. Otherwise `null` (master key not configured).

`POST /api/admin/setup` logic (only on a still-incomplete setup):

- If env `LATEDEV_MASTER_KEY` is set → leave everything as-is (env wins).
- Else:
  - If the request provides `setupMasterKey`, use that value.
  - Else if `<dataDir>/master.key` exists → reuse it (no rewrite).
  - Else generate `crypto.randomBytes(32).toString('base64')`, write the file
    (mode `0o600`, `fs.writeFileSync`) and set `masterKeyConfigured: true`.
  - The effective key is then set into the running config (see below).

### Config cache fix (pre-existing bug)

`setup.ts` currently writes `process.env.LATEDEV_MASTER_KEY` after `loadConfig()`
has already cached a config, so `cached.masterKey` stays `null` and providers
cannot be created in the same process run. Fix: expose a
`setConfigMasterKey(value: string)` on `config/index` that updates the cached
`RuntimeConfig.masterKey` (and, for parity, the parsed env if present) and call
it during setup. This also makes `isMasterKeyConfigured()` / `getMasterKey()`
return the new key immediately.

### Security invariants

- The key is never stored in SQLite.
- It is never returned by the UI/API and never logged (docs/07 invariants hold).
- The file lives outside the DB, so backups do not include it; operators that
  restore a backup on another host must also copy `master.key`.
- File mode 0600; created only on setup; not created when env key is provided.

### Tests

- Integration: fresh data dir + no env → setup → `master.key` exists, provider
  create succeeds in the same process (regression for the old cache bug).
- Integration: fresh data dir + `setupMasterKey` supplied → file written, same
  restart semantics.
- Integration: env key set → no file written, env key used.
- Unit: `loadConfig` falls back to `master.key` contents when env absent.

---

## 2. Readable/settable API keys (encrypt-at-rest)

### Schema (migration 0002)

New columns on `api_keys` (`key_secret_encrypted TEXT`, `key_secret_nonce TEXT`).
Nullable — existing rows are unaffected and simply have no recoverable secret.

Migration file: `migrations/0002_source_api_key_secrets.sql` (raw SQL
`ALTER TABLE ... ADD COLUMN`, matching the project's existing raw-SQL migration
setup). `SCHEMA_VERSION` in `db/migrate.ts` and the `schema.ts` Drizzle type must
both be updated.

### Create flow

`POST /api/admin/api-keys` body gains optional `secret?: string` (the custom
value). Validation:

- If provided, trimmed, non-empty, `maxLength` bounded (e.g. 256).
- Stored/used verbatim — no `ld-` prefix insertion, no length rewrite (per
  decision #4).

Regardless of source (custom verbatim value, or auto `generateApiKeySecret()`):

- `keyPrefix = secret.slice(0, 11)` (unchanged convention).
- `keyDigest = sha256Hex(secret)` — remains the auth path (unchanged).
- Additional: encrypt the full secret with `encryptSecret()` (AES-256-GCM,
  existing util) and store ciphertext/nonce on the new columns. Requires the
  master key to be configured (already enforced for provider keys; the
  auto-gen path guarantees it for fresh installs).
- Response still returns `{ id, name, secret, keyPrefix }` once at creation.

### Read flow

`GET /api/admin/api-keys` (list) adds `secret: string | null` per row, decrypted
from `key_secret_encrypted` via `decryptSecret()` when present (else `null`).
`GET /api/admin/api-keys/:id` likewise.

### UI (`src/web/app/pages/api-keys.tsx`)

- Table: a per-row action column with two small buttons:
  - **Copy** — copies full secret to clipboard; toast “Copied”.
  - **Eye / show** — opens the same reveal dialog showing the full secret with a
    Copy button; closable and re-openable any number of times.
- Rows where `secret == null` (legacy keys) degrade gracefully: Copy/Eye
  disabled with a tooltip "secret not stored".
- "New key" dialog: add optional **Key value** input, placeholder
  `(leave empty to auto-generate ld-…)`; empty → backend generates.
- Creation result dialog keeps working as today (secret shown once with Copy).

### Backwards compatibility

- Old keys (no secret columns populated) → secret `null`, UI disables actions.
- Docs/05 “never store plaintext key” remains true: we store only a digest plus
  an authenticated-encryption ciphertext, never the raw secret.

### Tests

- Integration: create → list returns a `secret` equal to the returned creation
  secret for the same key id (decrypts from DB).
- Integration: custom secret submitted verbatim is echoed back verbatim on list;
  digest matches `sha256Hex(custom)` AND differs from stored ciphertext.
- Integration: a legacy row with no stored secret returns `secret: null`.
- E2E: create key via UI, dismiss dialog, Copy + Eye row actions still work.

---

## 3. Brand logo

### Assets

The root `latedev.svg` (1.2 MB, 1024² PNG embedded via `data:image/png;base64`)
is the source. Extract the base64 PNG and produce, via a one-off script
`scripts/generate-logo.ts` (dev-only, run manually), using **`pngjs`** (pure-JS,
no native binary — matches the project's small-dependency stance) added as a
devDependency:

- `src/web/public/favicon.png` — 48×48 (tab icon).
- `src/web/public/logo.png` — 128×128 (28px display in sidebar/login/setup is
  high-DPR friendly); keep each a few KB.

The script decodes the embedded PNG with pngjs, resizes down, and writes the two
RGBA PNGs. Run once, commit the outputs — no runtime dependency added.

The 1.2 MB root file is **not** deleted and **not** referenced by the build.
The old `public/favicon.svg` may be removed (surfacing its removal is the only
cleanup; nothing else references it besides `index.html`).

### Wiring

- `src/web/index.html`: `<link rel="icon" type="image/png" href="/favicon.png">`.
- `src/web/app/components/sidebar.tsx`, `login.tsx`, `setup.tsx`: replace the
  `bg-primary ... font-bold">L</div>` block with
  `<img src="/logo.png" alt="LateDev Router" className="h-7 w-7 object-contain ...">`
  (h-8/w-8 on login/setup, matching current box sizes).

### Tests

- E2E smoke: pages still render, sidebar/login/setup show the img (assert
  `img[src*="logo.png"]` visible), favicon link present in built `index.html`.
- Manual: favicon renders in browser tab.

---

## 4. Docs updates

- `docs/05-API-KEYS-LIMITS-AND-IP.md`: note that secrets are additionally stored
  encrypted (AES-256-GCM) for admin recovery; plaintext still never stored.
- `docs/07-SECURITY-ADMIN-AND-BACKUP.md`: master key may now be a generated file
  at `<dataDir>/master.key`; clarify it must accompany a restored backup.
- `docs/08-ADMIN-UI-UX.md`: create flow gains optional custom key + recoverable
  copy/Eye actions.
- `.env.example`: update the `LATEDEV_MASTER_KEY` comment to mention auto-gen via
  `master.key` when unset.

## Out of scope

- No change to backup file format / restore semantics.
- No RBAC/multi-user/SSO.
- No gateway-side behavior change (auth still digest-based).
- No Dockerfile/docker-compose changes.

## File touch map

Backend:
- `src/server/config/index.ts` (file `master.key` fallback in `loadConfig` +
  `setConfigMasterKey()`; env-only — no new CLI flag)
- `src/server/auth/crypto.ts` (no change needed; consumes config)
- `src/server/routes/admin/setup.ts` (auto-gen + file write + cache fix)
- `src/server/routes/admin/api-keys.ts` (custom secret + encrypted storage + list decrypt)
- `src/server/db/schema.ts`, `src/server/db/migrate.ts`, `migrations/0002_*.sql`
- `docs/**`, `.env.example`

Frontend:
- `src/web/app/pages/api-keys.tsx` (Key value input + Copy/Eye row actions)
- `src/web/index.html`, `sidebar.tsx`, `login.tsx`, `setup.tsx` (logo)
- `src/web/public/favicon.png`, `logo.png` (generated)

Tests:
- `tests/integration/master-key.test.ts` (new)
- `tests/integration/api-keys.test.ts` (new; or extend security/cache)
- `tests/e2e/critical.spec.ts` (extend for copy/eye + custom key + logo smoke)