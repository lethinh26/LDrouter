# 03 — Protocol Compatibility

## Goal

A client should be able to point a normal OpenAI-style or Anthropic-style SDK at LateDev Router with minimal or no application code changes.

Compatibility is semantic, not merely “the JSON parses.” Streaming, errors, tool calls, usage, finish reasons, and headers matter.

## Public gateway endpoints

Implement at minimum:

### OpenAI-compatible

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

### Anthropic-compatible

```text
GET  /v1/models
POST /v1/messages
POST /v1/messages/count_tokens
```

### Operational/admin

Keep admin APIs in a separate namespace, for example:

```text
/api/admin/*
/health
/ready
/metrics
```

Do not mix admin auth with gateway bearer keys.

## Authentication compatibility

### OpenAI-style client

Accept:

```http
Authorization: Bearer ld-...
```

### Anthropic-style client

Accept the normal Anthropic API-key header shape for compatibility, but the value is a LateDev key beginning `ld-`.

If multiple credential headers are present, use a deterministic precedence and reject ambiguous/conflicting credentials when appropriate.

## `GET /v1/models`

Return only targets the requesting API key is allowed to access.

Eligible public targets:

- enabled physical models that are available
- enabled combos with at least one eligible usable member
- enabled aliases whose target is eligible

Never leak provider credentials or private admin metadata.

## Model resolution

Input `model` may be:

1. physical model public ID: `provider/model`
2. combo public ID: `combo/name`
3. configured alias: `coding`

Resolution must happen before ACL/capability-aware routing is finalized.

Record both:

- model string requested by client
- resolved target

## Canonical representation

Implement explicit adapters:

- OpenAI Chat Completions -> canonical
- OpenAI Responses -> canonical
- Anthropic Messages -> canonical
- canonical -> OpenAI-compatible upstream
- canonical -> Anthropic-compatible upstream
- upstream result/events -> canonical result/events
- canonical result/events -> originating client protocol

Do not create hidden lossy behavior. If a field cannot be represented safely, return a gateway compatibility error.

## Streaming

Streaming must be end-to-end with backpressure. Do not concatenate the full upstream body first.

Track these phases:

```text
request accepted
upstream attempt opened
first upstream event/token received
first client stream data flushed
stream completed / stream failed
```

TTFT is measured consistently and documented.

### Critical fallback rule

Fallback is allowed only before the gateway has begun a semantically committed response to the client.

For streaming, once meaningful stream data for an upstream generation has been sent to the client, do not silently switch to another model. If the upstream fails after that point:

- mark attempt `partial_response=true`
- mark request failed/partial as appropriate
- terminate with the closest protocol-correct error/stream-ending behavior possible
- never concatenate another model's answer into the same stream

## Tools/function calling

Preserve:

- tool definitions
- tool names
- JSON schema/input definitions
- tool call IDs where semantics require them
- tool call arguments
- tool results
- stop/finish reason semantics as closely as possible

Candidate models lacking tool support must be excluded when the incoming request requires tools.

## Structured output

When the incoming protocol asks for JSON schema/structured output:

- route only to candidates known to support a safe equivalent, or
- return an unsupported-capability error.

Do not silently degrade strict structured output to unconstrained text.

## Multimodal content

Canonical content should support typed blocks. At minimum preserve distinctions between text and image input where both protocols/upstreams support them.

If an incoming request includes a modality unsupported by all candidates, return a clear 4xx compatibility/capability error before consuming upstream quota.

## Reasoning/thinking

Reasoning/thinking fields vary across vendors. Treat them as provider capabilities/extensions. Map only when semantics are understood and safe. Unknown fields may be forwarded only when the upstream protocol and provider are the same compatible family and forwarding does not violate validation/security rules.

## Token usage

Normalize usage into:

- input tokens
- output tokens
- cache read tokens
- cache write tokens
- reasoning tokens
- total tokens

Some providers will omit some categories. Store null/zero according to a consistent convention documented in code.

Do not fabricate provider-reported usage.

## Token counting endpoint

For Anthropic-compatible `count_tokens`:

1. resolve target/model permissions
2. use upstream-native counting when available and semantically correct
3. otherwise use a trustworthy local tokenizer only if exact/compatible for the selected model
4. if exact counting is not supported, return a clear unsupported error rather than a misleading estimate

## Errors

Create canonical error categories such as:

- authentication_error
- permission_error
- invalid_request_error
- model_not_found
- capability_not_supported
- rate_limit_error
- timeout_error
- upstream_auth_error
- upstream_rate_limit
- upstream_unavailable
- upstream_error
- gateway_error

Encode them into the originating client protocol's expected error envelope and suitable HTTP status.

All upstream error bodies must be sanitized before logging or returning. Never expose upstream API keys, secret headers, internal stack traces, DB paths, or master-key information.

## Forwarded headers

Use an explicit safe allowlist. Never blindly forward all incoming headers upstream or all upstream headers back to the client.

Useful request correlation headers may be preserved/recorded. Strip hop-by-hop headers.

Read next: `04-ROUTING-AND-RESILIENCY.md`.
