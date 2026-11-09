# Schema Integer Compatibility Implementation Plan

**Goal:** Accept Gemini/Antigravity string-encoded integer constraints without changing tool argument data.

**Architecture:** Normalize known JSON Schema integer keywords at the OpenAI and Anthropic canonical-input boundaries. Walk only schema-bearing keywords, preserve annotations and extension data, and reject unsafe conversions with HTTP 400.

**Tech stack:** Existing TypeScript, native JavaScript, Vitest and Fastify tests; no new dependencies.

## Constraints

- Preserve streaming, routing, arguments, `enum`, `const`, `default`, and examples.
- Do not log schema values or secrets, change deployments, or publish a release.
- Limit traversal depth and avoid prototype-sensitive object assignment.

## Task: Normalize schema integer constraints

- [x] Add `tests/unit/schema-integers.test.ts`: real input adapters, string bounds, nested schemas, literal preservation, invalid values, and excessive nesting.
- [x] Run `pnpm exec vitest run tests/unit/schema-integers.test.ts`; verify string-versus-number failures before implementation.
- [x] Add `src/server/protocols/json-schema.ts` with `normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown>` for `minItems`, `maxItems`, `minLength`, `maxLength`, `minProperties`, `maxProperties`, `minContains`, and `maxContains`.
- [x] Call it for tool schemas in `openAIToCanonical` and `anthropicToCanonical`, and Chat structured-output schemas. Reject non-decimal strings and non-safe/nonnegative integers rather than guessing.
- [x] Add Chat/Messages HTTP tests in `tests/integration/gateway.test.ts`: streaming, non-streaming, and rejection before upstream calls.
- [x] Document the behavior in `docs/03-PROTOCOL-COMPATIBILITY.md`.
- [x] Run focused tests, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; inspect the diff and GitNexus change report.

Validation: regression tests failed before the fix; the full suite now has 581 passing tests and 41 pre-existing skips. Lint, typecheck, build, and diff whitespace checks pass. GitNexus reports medium aggregate change risk, limited to the expected protocol-normalization flows. No live upstream or deployed relay was modified or tested.

The existing Responses subset has no tool-definition mapping. Run its existing smoke coverage, but do not expand Responses features in this schema-conversion fix.
