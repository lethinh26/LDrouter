# 00 — Product Scope

## Product

**LateDev Router** is a lightweight, self-hosted LLM gateway and admin web application. It presents stable OpenAI-compatible and Anthropic-compatible APIs to internal applications while routing traffic to one or more upstream LLM providers.

The primary user is usually a single person operating the gateway for a company or private infrastructure. Therefore the first version has one administrator account rather than a full multi-user/RBAC system.

## Core goals

1. Put multiple LLM providers behind one gateway.
2. Give every provider model a stable, collision-free public ID.
3. Let the admin construct virtual combo models using fallback or weighted round robin.
4. Preserve streaming semantics and tool/function calling compatibility.
5. Restrict API keys by model, expiry, IP/CIDR, request/token rate, and concurrency.
6. Make failures diagnosable through request logs and upstream attempt logs.
7. Provide useful usage statistics without implementing financial cost accounting.
8. Remain easy to deploy: one Node process + one SQLite database by default.
9. Be distributable as an npm package and runnable through Docker Compose.

## Required navigation

The desktop sidebar should contain:

- Dashboard
- Providers
- Models
- Combos
- API Keys
- Requests
- Statistics
- Audit Logs
- Settings

On small screens, use a responsive drawer/sheet navigation.

## Functional scope

### Providers

A provider has:

- display name
- unique slug
- protocol type: `openai` or `anthropic`
- base URL
- encrypted upstream API key
- optional custom headers
- enabled/disabled status
- connect timeout
- first-token timeout
- stream idle timeout
- total request timeout
- retry configuration
- health status

Provider slugs must be URL/model-ID safe and unique.

### Models

The gateway must support model discovery from providers. Discovery is selective:

1. Admin clicks **Fetch Models**.
2. Gateway fetches all pages from the provider's model listing API where pagination exists.
3. UI opens a searchable modal.
4. Existing models are clearly marked.
5. Admin checks individual models to import.
6. There is a **Select All** action.
7. Nothing is imported merely because discovery was run.
8. Import only occurs after explicit confirmation.

Every physical model has:

- internal UUID
- provider UUID
- upstream model ID
- public model ID
- display name
- enabled status
- upstream-available status
- capabilities
- optional metadata

Public ID format:

```text
<provider-slug>/<upstream-model-id>
```

Example:

```text
latedev/gpt-5.5
```

If an upstream model disappears on a later sync, do not delete it. Set `upstream_available=false` and preserve history/combo references.

### Model capabilities

Track, at minimum:

- chat/messages
- OpenAI Responses
- streaming
- tools/function calling
- structured output
- image input
- audio input
- reasoning/thinking
- embeddings
- max context tokens, when known
- max output tokens, when known

Unknown capabilities must remain explicitly unknown rather than guessed. The UI may allow the admin to override discovered capability metadata.

### Combos

A combo is a virtual model composed only of physical models.

Required routing modes:

- fallback
- weighted round robin

Each combo chooses one mode independently.

A combo has a stable public ID:

```text
combo/<slug>
```

Clients can use a combo exactly where they would normally use a model ID.

Nested combos are forbidden in v1.

### Aliases

Support model aliases so a stable client-visible name can point to either:

- one physical model, or
- one combo.

Examples:

```text
coding -> combo/coding
fast -> latedev/gpt-fast
```

Aliases cannot shadow existing physical or combo public IDs.

### Request logs

Display request logs as a paginated/filterable list. Each request row shows enough information to diagnose it quickly:

- success/failure
- timestamp
- gateway request ID
- requested model/alias
- resolved combo, if any
- final physical model
- API key name/prefix
- HTTP status
- streaming/non-streaming
- input tokens
- output tokens
- cache read tokens
- cache write tokens when available
- reasoning tokens when available
- total latency
- time to first token when available
- number of attempts
- client IP
- endpoint/protocol

A failed request has an expandable error section. A request routed through multiple upstreams has an expandable attempts section.

Do not implement monetary cost fields.

### Statistics

Required date presets:

- Today
- Last 7 days
- Last 30 days

Required summary metrics:

- total requests
- successful requests
- failed requests
- success rate
- input tokens
- output tokens
- total tokens
- cache tokens
- reasoning tokens when available
- average latency
- p95 latency
- average/p95 TTFT when available
- cache-hit rate
- fallback rate

Required charts:

- requests over time
- tokens over time
- errors over time

Required ranked sections:

- Top 10 requested models
- Top API keys
- Top providers
- Models/providers with highest error rates (with a sensible minimum sample threshold)

No money/cost charts.

### Settings

Required settings:

- request-log retention policy
- request-content logging policy
- maximum database/log size guard
- download database backup
- restore/upload database backup
- change administrator password
- configure/disable TOTP 2FA
- trusted proxy configuration
- master-secret/encryption status display without exposing the secret

### Audit logs

Audit administrative actions independently from request logs. Request-log retention must never delete audit records.

At minimum audit:

- login success/failure
- password change
- 2FA enabled/disabled/recovery-code regeneration
- provider create/update/delete/enable/disable
- provider credential replacement
- model import/update/enable/disable
- combo create/update/delete/enable/disable
- alias create/update/delete
- API key create/revoke/update
- DB download
- DB restore attempt/success/failure
- security/settings changes

## API key format

All gateway-issued API keys must begin with:

```text
ld-
```

Recommended full format:

```text
ld-<43-character base64url random payload>
```

Generate at least 256 bits of CSPRNG entropy. Display the secret once at creation time. Store only a cryptographic one-way digest plus a short non-secret prefix for identification.

## Non-goals

This version does not include:

- cost/billing
- multi-user/RBAC
- organization hierarchy
- SSO
- nested combos
- arbitrary code/plugin execution inside routing rules

Read next: `01-ARCHITECTURE.md`.
