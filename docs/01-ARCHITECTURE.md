# 01 — Architecture

## Architectural principle

LateDev Router must remain operationally small: one application process and one SQLite database by default.

Avoid microservices. Internal boundaries should exist as TypeScript modules, not separate deployables.

## Runtime topology

```text
Client SDK / application
        |
        v
+----------------------------+
| LateDev Router             |
|                            |
| HTTP compatibility layer   |
| Auth / IP / limits         |
| Model + alias resolver     |
| Combo router               |
| Protocol adapters          |
| Upstream client            |
| Logs / metrics / audit     |
| Admin API                  |
| Static React admin UI      |
+-------------+--------------+
              |
              v
          SQLite WAL
              |
              +---- encrypted provider secrets

Upstreams: OpenAI-compatible and Anthropic-compatible endpoints
```

## Recommended repository layout

```text
/
├─ AGENTS.md
├─ README.md
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
├─ vite.config.ts
├─ Dockerfile
├─ docker-compose.yml
├─ .dockerignore
├─ .env.example
├─ src/
│  ├─ cli.ts
│  ├─ server/
│  │  ├─ app.ts
│  │  ├─ config/
│  │  ├─ db/
│  │  │  ├─ schema.ts
│  │  │  ├─ migrations/
│  │  │  └─ repositories/
│  │  ├─ auth/
│  │  ├─ providers/
│  │  ├─ models/
│  │  ├─ routing/
│  │  ├─ protocols/
│  │  │  ├─ canonical/
│  │  │  ├─ openai/
│  │  │  └─ anthropic/
│  │  ├─ limits/
│  │  ├─ logging/
│  │  ├─ metrics/
│  │  ├─ backup/
│  │  └─ routes/
│  └─ web/
│     ├─ main.tsx
│     ├─ app/
│     ├─ components/
│     ├─ pages/
│     ├─ hooks/
│     └─ lib/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  └─ e2e/
└─ docs/
```

Equivalent organization is acceptable if it preserves these boundaries.

## Canonical internal request model

Do not implement conversion by directly translating every provider request into every other provider request. That becomes an N×N adapter matrix.

Use a canonical internal representation:

```text
OpenAI request -----\
                     > canonical request -> router -> canonical upstream intent
Anthropic request --/

canonical response/event -> protocol-specific encoder -> client
```

The canonical layer should model:

- messages/content blocks
- roles
- text blocks
- image/document input references where supported
- tool definitions
- tool calls/tool results
- system instructions
- model
- temperature/top-p and common generation parameters
- max output tokens
- stop sequences
- reasoning/thinking configuration when safely mappable
- response format/structured output intent
- stream flag
- metadata required for logging/routing

Never silently discard an unsupported semantic feature. Either:

1. map it correctly,
2. select only a model/provider that supports it, or
3. return a clear compatibility error before calling upstream.

## HTTP layers

Recommended request flow:

```text
Request ID
  -> client IP resolution
  -> gateway API-key authentication
  -> IP allow/deny check
  -> key expiry/status check
  -> endpoint/body validation
  -> model/alias resolution
  -> model ACL check
  -> rate/token/concurrency admission
  -> canonical conversion
  -> capability requirements derivation
  -> route candidate selection
  -> upstream attempt loop
  -> stream/non-stream response encoding
  -> usage finalization
  -> request + attempt persistence
  -> metrics
```

Admin API requests use administrator session authentication instead of gateway API keys.

## SQLite

Use WAL mode and sane pragmas at startup. Keep writes short. Do not hold a long DB transaction open while waiting for an LLM response.

For request logging:

- create lightweight request state in memory at request start,
- append attempt information as attempts complete,
- persist/finalize efficiently,
- batch non-critical metrics aggregation only if needed.

Indexes must support the common filters described in the data-model document.

## In-memory state

It is acceptable and preferred to keep these process-local in v1:

- token buckets/rate limiter state
- concurrency counters
- circuit breaker state
- weighted round-robin cursor/state
- short-lived provider health state

The SQLite configuration remains source of truth. Restarting the process may reset short-duration rate-limit/circuit state; document this behavior.

Do not require Redis.

## Single-process packaging

Production build should contain:

- compiled Node server
- bundled React static assets
- migration assets
- CLI entry point

CLI examples:

```bash
npx latedev-router
latedev-router --host 0.0.0.0 --port 8787
```

Recommended default data directory:

```text
~/.latedev-router/
```

Container default:

```text
/data/
```

Store database and generated persistent local state under the data directory. Never bake secrets into the image.

## Configuration

Support environment variables for bootstrapping critical runtime settings, including at minimum:

```text
LATEDEV_HOST
LATEDEV_PORT
LATEDEV_DATA_DIR
LATEDEV_MASTER_KEY
LATEDEV_TRUST_PROXY
LATEDEV_LOG_LEVEL
```

`LATEDEV_MASTER_KEY` is mandatory once encrypted provider credentials exist. Define a safe first-run setup flow in the security document.

Read next: `02-DATA-MODEL.md`.
