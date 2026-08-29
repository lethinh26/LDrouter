# 05 — API Keys, Limits, and IP Controls

## Key generation

Every key begins with `ld-`.

Use a cryptographically secure random generator with at least 256 bits of entropy. Recommended representation:

```text
ld-<base64url(random 32 bytes)>
```

Rules:

- show plaintext once after creation
- provide Copy button in UI
- after creation, admin can recover secrets from DB anytime via per-row Copy/Eye actions (secrets are encrypted-at-rest)
- never show full key again in client-facing contexts
- never store plaintext key (stored as SHA-256 digest; secrets additionally encrypted at rest with AES-256-GCM)
- never log plaintext key
- never place plaintext key into audit metadata

Store:

- key digest (SHA-256 is appropriate for a uniformly random high-entropy API token)
- short prefix/suffix needed for human identification, e.g. `ld-AbCd…Xy9`
- name and restrictions

Constant-time compare where applicable.

## Key lifecycle

Support:

- create
- disable/enable
- revoke/delete
- optional expiry datetime
- last-used timestamp

Revoked/expired key receives an authentication/permission error without indicating too much sensitive detail.

## Model allowlist

At creation and edit time, the admin chooses allowed targets.

The UI needs a searchable selector grouped by:

- Combos
- Aliases
- Providers / physical models

Support either:

- explicit allowlist, or
- an explicit `allow_all_models` setting

Never interpret an accidentally empty allowlist as unrestricted.

If a combo is allowed, the key may use that combo but must not automatically gain direct access to each physical member unless those physical model IDs are also allowed. Internal combo execution is allowed because authorization was granted to the combo.

## IP rules

Support IPv4 and IPv6:

```text
192.168.1.10
10.0.0.0/8
2001:db8::/32
```

Provide Allow and Deny rules.

Evaluation:

1. any deny match => reject
2. if allow rules exist, require at least one allow match
3. otherwise allow

## Trusted proxy safety

Do not trust `X-Forwarded-For` or similar headers from arbitrary internet clients.

Support a trusted-proxy configuration that controls when forwarded IP headers are honored. Default must be safe for direct exposure.

Document deployment behind common reverse proxies without hard-coding vendor-specific trust.

## Limits

Per API key support:

- requests per minute (RPM)
- tokens per minute (TPM)
- daily token limit
- monthly token limit
- maximum concurrent in-flight requests
- maximum output tokens per request

No monetary cost limits.

Nullable limit means unlimited for that dimension.

## Admission algorithm

### RPM

Use an in-memory token bucket or sliding-window implementation that is safe enough for a single-process server.

### TPM

Because final output tokens are not known at admission time:

- account for known/requested input tokens when reliably available
- reserve a bounded estimate based on requested max output tokens where appropriate
- reconcile against actual usage after completion
- choose behavior that cannot be trivially bypassed by omitting `max_tokens`

Document the exact policy and test it.

### Daily/monthly tokens

Persist usage so process restarts do not erase period quotas.

Avoid scanning the entire requests table on every request. Maintain or query indexed usage aggregates efficiently.

### Concurrency

Increment only after all cheap auth/IP checks pass. Use `finally`/abort hooks so counters are released on disconnect/error.

## Limit response

Return HTTP 429 for exceeded dynamic rate/quota limits unless a more appropriate protocol-specific status exists. Include a useful `Retry-After` when it can be calculated.

Log the denial as a request outcome without leaking secrets.

Read next: `06-LOGGING-PRIVACY-AND-STATISTICS.md`.
