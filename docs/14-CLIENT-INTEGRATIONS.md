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

OpenAI's official [Sign in with ChatGPT OSS guide](https://developers.openai.com/siwc/token-sharing-open-source)
describes plan-eligible inference at `https://api.openai.com/v1/responses`,
including [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
The preview does not support an upstream `max_output_tokens` parameter; the
gateway must fail closed rather than promise an enforceable token cap it cannot
send. OpenAI eligibility and authorization are not inferred from the token
format or from a model name. A remotely hosted or paid service must obtain
the applicable permission from OpenAI before offering plan usage.

Anthropic's [authentication and credential-use policy](https://code.claude.com/docs/en/legal-and-compliance)
does not permit third-party services to collect, store, or intermediate
Claude subscription OAuth credentials. The Claude Code integration is therefore
API-key based, for the key owner's own authorized use. There is no Claude
subscription login button or account-pool implementation.
