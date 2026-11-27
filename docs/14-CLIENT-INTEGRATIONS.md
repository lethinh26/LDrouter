# Client integrations

## Built-in Provider Center (schema 0019)

The Providers page separates the immutable built-in registry from ordinary
compatible providers. Codex has the canonical prefix `cx/`; Claude Code has
`cc/`. They are visible even before any connection is configured. Custom
providers cannot claim either slug or the reserved `builtin-connection-`
storage prefix.

Migration 0019 adds `provider_connections` linked to integration identities.
Existing integration rows become **legacy connections** without changing any
provider UUID, public model ID, model UUID, encrypted credential, combo member,
alias, API-key permission or history. Legacy providers can still be managed in
the built-in detail page, using their original prefixes. If a custom/legacy
provider or historical model, combo or alias occupies a canonical namespace,
the page reports the conflicts and prevents creation in that namespace. Existing
routes remain usable. Resolve the conflicts explicitly; do not delete or
rename a production route without first checking its clients and ACLs.

New built-in connections have a fixed public prefix and an internal transport
UUID. Each imported canonical model is **bound to the chosen connection**.
If a second connection offers the same upstream model ID, discovery marks it
as already bound elsewhere and import returns 409 instead of changing its
credential or expanding existing permissions. The same provider may contain
several independent authorized Claude API-key connections for different
workspaces. The Codex client-owned authentication method has one canonical
profile (older legacy profiles remain usable); the actual signed-in identity
is chosen and held by the Codex client, not by the router.

Manage connections from Providers → Built-in Providers → Manage. Rename,
disable/enable, inspect model assignments, test Claude API-key connectivity,
and copy client configuration. Disabling stops new dispatch to that connection
without deleting the models, permissions or encrypted key. It is **not**
upstream credential revocation. Canonical credential replacement is rejected
to prevent silently changing the owner of a routed model; removing an empty
connection is allowed by the compatibility API, while removing one with bound
models is rejected. Retire or explicitly reconfigure those routes first.

Connection usage is the gateway's existing daily provider aggregate keyed by
the transport UUID: upstream attempts and input + output tokens. It survives
compact export and raw request-log retention. It is not a subscription quota,
remaining balance, unique client-request count, or billing data.

The dedicated API is `GET /api/admin/builtin-providers` and
`POST /api/admin/builtin-providers/:kind/connections`. Both require admin
authentication; mutations also require CSRF. The existing provider APIs are
retained for compatibility and for connection operations by UUID.

The Provider Center does not implement browser-based subscription OAuth,
callback-token collection, managed refresh, subscription account pools, or
automatic cross-account switching. An approved upstream integration grant
would be required for the applicable managed login flow. Do not interpret a
saved Codex profile as a verified signed-in account or a newly saved Claude
API key as verified until its connection test succeeds.

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
`X-API-Key` or first-party `X-Gateway-Token` and forwards only the signed-in Authorization and optional
ChatGPT-Account-ID to the fixed `https://chatgpt.com/backend-api/codex` origin.
Redirects, stored client credentials, and custom upstream headers are forbidden.

1. Create the Codex client profile in the built-in Provider Center and import the exact upstream model IDs you are
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
model = "cx/YOUR_IMPORTED_MODEL"

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
this combo; both client authorization and gateway authorization are required.

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

### First-party Gateway OAuth (schema 0020)

This is LDrouter's own authorization server for the documented Codex Gateway
OAuth integration. It is **not** a ChatGPT or Claude subscription login.
Create an appropriately scoped, uncapped native Codex gateway API key first.
In the Codex connection detail, copy the Gateway OAuth configuration, rather
than the static API-key configuration. The fixed public client uses:

```toml
[model_providers.latedev-codex.gateway_oauth]
authorization_url = "https://YOUR_GATEWAY/oauth/authorize"
token_url = "https://YOUR_GATEWAY/api/oauth/token"
client_id = "ldrouter-codex"
redirect_port = 43127
delivery = { kind = "header", name = "X-Gateway-Token", scheme = "Bearer" }
```

Keep the native model provider settings above, including
`requires_openai_auth = true`, but omit `env_http_headers` for this method.
Use HTTPS remotely. When proxy trust is enabled, restrict direct access to
the gateway origin to the trusted reverse proxy and ensure the proxy replaces
untrusted client-supplied forwarded protocol and IP headers. The current
Fastify proxy trust setting is not a per-proxy address allowlist. HTTP is
supported only for local loopback OAuth transport. The admin IP access policy
applies to consent and token endpoints.

The client opens the browser, the operator signs into LDrouter and explicitly
approves an existing gateway key, and the browser returns a one-time code to
the fixed loopback callback `http://127.0.0.1:43127/callback`. The client uses
PKCE S256 to exchange the code (five-minute expiry), receives a 15-minute
access token and a rotating refresh token with a 30-day idle expiry and a
90-day absolute grant lifetime. Successful rotation invalidates the previous
access token; reuse of a spent refresh token revokes the family. The client
must reauthorize after expiry, replay or revocation. Only token digests are
stored. Providers displays grant metadata and a revoke action; no token is
displayed or exported. A normal restart preserves valid grants, but database
restore invalidates them. The underlying API-key identity, ACL, IP restrictions,
rate/concurrency limits and usage accounting remain authoritative. Disable or
delete that key to block new gateway authorization. Revocation prevents new
requests and fallback dispatches; it cannot retract an already sent request.
Gateway OAuth is accepted only on native Codex endpoints; legacy API keys still
work. The two gateway credential headers must not be combined.

### Upstream OAuth authorization boundary

Client ChatGPT sign-in and refresh remain with Codex.
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

1. Add a Claude Code connection in the built-in Provider Center using the authorized Anthropic API key. The
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
export ANTHROPIC_MODEL="cc/YOUR_IMPORTED_MODEL"
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
