# Client integrations

## Identity and credential boundary

Migration 0017 introduces `provider_integrations`, keyed by the existing
provider UUID. Providers without an integration row remain compatible API-key
providers, regardless of their name or slug. The `providers.type` column
continues to represent the wire protocol (`openai` or `anthropic`).

| Integration | Protocol | Authentication |
|---|---|---|
| Compatible (no row) | OpenAI or Anthropic | Encrypted provider API key |
| `codex` | OpenAI | Client-held, authorized Sign in with ChatGPT access token |
| `claude_code` | Anthropic | Owner's authorized API key |

The new table contains no secret material. No old Codex/Qoder account tables
or credentials are restored. Provider API keys retain AES-256-GCM encryption;
client OAuth access/refresh/ID tokens are not persisted in the gateway DB,
backup, or logs. Login and token rotation belong to the eligible client that
obtained the grant; the gateway does not extract another application's login
state or impersonate its OAuth client ID.

## Codex gateway

The [documented Codex gateway integration](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway)
is distinct from the Sign in with ChatGPT OSS token-sharing preview. Codex
signs in and refreshes its own credential. LateDev validates a separate
`X-API-Key` and forwards only the signed-in Authorization and optional
ChatGPT-Account-ID to the fixed `https://chatgpt.com/backend-api/codex` origin.
Redirects, stored client credentials, and custom upstream headers are forbidden.

1. Create a Codex provider and import the exact upstream model IDs you are
   authorized to use. The actual account catalog is fetched only with the
   signed-in client; admin discovery does not invent model availability.
2. Create a gateway key limited to the desired models, native Codex combos or aliases. RPM, IP,
   expiration and concurrency limits remain available. Finite token quotas
   and output caps fail closed for native Codex because this adapter has not
   verified an enforceable upstream maximum. They are never silently ignored.
3. Set `LATEDEV_API_KEY` in the Codex process environment to the gateway key,
   and configure `~/.codex/config.toml` using your gateway URL and imported
   public model ID:

```toml
model_provider = "latedev-codex"
model = "codex/YOUR_IMPORTED_MODEL"

[model_providers.latedev-codex]
name = "LateDev Codex"
base_url = "https://YOUR_GATEWAY/backend-api/codex"
model_catalog_url = "https://YOUR_GATEWAY/backend-api/codex/models"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "X-API-Key" = "LATEDEV_API_KEY" }
```

Use TLS for remote access. Native HTTP Responses streaming preserves tool and
item IDs; use replayed input with `store=false`. Stored conversation and item
references are rejected; explicitly disabled model capabilities (tools, images,
audio and structured output) are enforced before dispatch. Server-side continuation,
WebSocket transport, background requests, account pooling and cross-provider
combo fallback are not supported. Catalogs are filtered to gateway ACLs and
are not shared between accounts. Native payloads are excluded from content
logging and response caching. Usage reported by the upstream is accounted for.
This integration does not establish eligibility for a particular OpenAI plan
or authorize a commercial relay. Follow the applicable service terms.

### Native Codex combos

Create a Combo with type **Codex native** and ordered, distinct Codex upstream
model IDs. Existing combos remain standard after migration 0018; kind is
immutable. Mixed API-key providers and native OAuth members are rejected.
Use the saved combo public ID (or a permitted alias) in the client configuration.
The ordinary OpenAI-compatible endpoints and synthetic admin Test cannot invoke
this combo; both client authorization and the gateway API key are required.

Configured availability is not an account entitlement. For every native combo
request the gateway fetches the signed-in account's catalog using that same
credential, with a bounded timeout and response size. All eligible members
must exist in the catalog and have matching behavioral metadata (including
context window and supported reasoning levels). Only cosmetic model identifiers,
labels, priority and upgrade hints are ignored during comparison. Incompatible
or missing entries suppress the combo in the catalog and fail closed at
dispatch. This conservative compatibility check may exclude some real model
combinations; live clients/catalogs have not yet been certified.

The gateway preserves the native Responses request and event/item/tool IDs.
Model-bound encrypted history and item references require a direct model.
Ordered fallback may occur on configured transport failures, timeouts, HTTP
408 or 5xx before any SSE output is sent. No fallback is permitted after output,
on 401/403/429, on semantic SSE errors or on malformed/incomplete responses.
Every attempt uses the same client credential and account header; no account
switching, shared adaptive state, token rotation or same-model replay is used.
Attempt and overall deadline limits still apply. No request payload or opaque
upstream request identifier is persisted for native Codex.

### OAuth authorization boundary

The gateway does not currently provide browser OAuth login, persistent profile
management or automatic refresh. Client sign-in and refresh remain with Codex.
A future integration-specific managed OAuth flow requires a provider-approved
registration, grant and deployment/storage policy permitting that specific use;
the official [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
do not establish permission for a general-purpose subscription relay or account
pool. Do not reuse another application's OAuth registration or credential store.
Claude Code remains API-key based as described below.

## Claude Code

Anthropic's [authentication and credential-use policy](https://code.claude.com/docs/en/legal-and-compliance)
does not permit third-party services to collect, store, or intermediate
Claude subscription OAuth credentials. The Claude Code integration is therefore
API-key based, for the key owner's own authorized use. There is no Claude
subscription login button or account-pool implementation.

1. Create a Claude Code provider using the authorized Anthropic API key. The
   destination is fixed to `https://api.anthropic.com`; arbitrary custom
   upstream headers and redirects are disabled. Existing Anthropic-compatible
   providers are unchanged.
2. Fetch the available models and import the chosen IDs. The catalog is fetched
   from Anthropic's Models API with pagination, not a static model list.
3. Create a scoped LateDev API key. Set the following environment variables in
   the Claude Code client process (substitute your actual gateway and model):

```sh
export ANTHROPIC_BASE_URL="https://YOUR_GATEWAY"
export ANTHROPIC_AUTH_TOKEN="YOUR_GATEWAY_API_KEY"
export ANTHROPIC_MODEL="claude-code/YOUR_IMPORTED_MODEL"
```

For Windows PowerShell, set the same variables via `$env:NAME = "value"`.
The client presents the LateDev key; the gateway authenticates upstream with
the encrypted provider API key, not the client's login token. Native Messages
requests preserve thinking and signatures, tool definitions, cache-control
and native response blocks while applying the gateway output cap. Valid
Anthropic version and beta headers are forwarded. Direct models and aliases
use the upstream `count_tokens` API; existing compatible/combo count requests
retain their local estimate. Native Claude responses are not replayed from the
gateway response cache. Features requiring different upstream protocols or
additional endpoints have not been certified with the live Claude Code client.

## Qualification

The CI native-client smoke uses pinned official CLI binaries in a disposable
Linux network/PID namespace with only loopback, fresh client homes, synthetic
credentials and a test-only upstream fixture. It exercises the built gateway
over HTTP, catalog filtering, native response completion and accounting. Codex
uses a fixture environment-key provider, not a fabricated ChatGPT sign-in.
This test does not establish real account eligibility or OAuth compatibility.

For an authorized live pilot, use the supported client sign-in or API-key
configuration above, one explicitly scoped gateway key and a disposable
working directory. Verify the selected model, incremental SSE completion,
tool-call/result loop, follow-up turn, revocation and reported usage. Record
only the client version, gateway request ID, target, status and sanitized
diagnostics. Never collect or export the user's authentication files. The
pilot requires a provider-authorized account and is separate from CI.
