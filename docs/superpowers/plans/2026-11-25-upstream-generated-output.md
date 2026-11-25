# Upstream generated output and SSE correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans. Run each regression before and after its fix on CI. This is a proposed plan, not an implemented fix.

**Baseline:** `main` at `071dc0b` (v2.0.0, 2026-11-25). **Goal:** return complete usable upstream generations to clients without falsely classifying them as `upstream_empty_response`; retain detection, bounded retry and fallback of genuinely empty generations.

**Architecture:** separate protocol decoding, semantic generation detection, downstream commitment, and completion. Use bounded buffering for metadata, stream deliverable generated content immediately, and keep output detection independent of token accounting. Apply the same normalization to streaming/non-streaming where practical; preserve protocol-specific fields. Avoid model-name-based workarounds.

**Tech stack:** TypeScript, Node >=22, Fastify, Vitest, existing OpenAI-compatible and Anthropic-compatible adapters.

## Constraints and scope

- No full local test/build, GitNexus reindex, live DB access or live provider calls on the user's weak PC. Use lightweight source inspection/replay; run focused regression and normal verification in CI. Before production edits obtain GitNexus impact if available; report missing graph access, not invented results. Do not reset or overwrite other changes.
- P0: eliminate verified false empty responses for valid generations, including long reasoning; preserve actual retries, direct/combo behavior, deadlines, cancellation, health and adaptive recovery. P1: independently address verified SSE parser/termination defects and narrow compatible wire formats. Cross-family streaming conversion and full Responses streaming are separate P2 work (see below); do not silently claim full compatibility.
- No new dependency, global disabling of empty-response checks, arbitrary larger unbounded buffer, output-token-only success rule, raw content logging, or production data reset. No schema migration expected for P0/P1.
- Once any meaningful downstream generation is committed, never fallback/retry or combine two models in that response. Metadata alone never commits or satisfies TTFT. Preserve final usage and provider-reported finish reason; do not invent final text, usage, tool IDs or reasoning.

## Evidence and reproduction (already executed)

The exact error is constructed in `src/server/gateway/runner.ts:1447–1452`. The streaming handler recognizes only OpenAI `delta.content`, `delta.refusal`, and `delta.tool_calls`, or Anthropic text deltas/tool starts (949–1007). Before any recognized output, it queues every encoded event and throws at >128 events or >65,536 characters (1012–1022), then `callUpstreamStreaming` cancels its reader (382–387). The code was introduced in `699e079` on 2026-11-14 (v1.20.4), prior to adaptive fallback. `initialBytes` is actually UTF-16 string length, not bytes. At clean EOF, `!streamStarted` also causes the same empty error (1050). Non-streaming checks only canonical text/tool calls (800, 1440); its OpenAI adapter discards content parts and empty-string-plus-refusal (canonical.ts:203–205).

Two disposable Node 24 replays extracted the actual current `runStreamingAttempt`, `callUpstreamStreaming`, `openAIResponseToCanonical`, `isEmptyGeneration` and error constructor, stripped TypeScript via `node:module`, and supplied fake fetch/Response/downstream pipe with synthetic payloads. No app server, dependency loading, real DB, or real upstream; each run took <1 s. They established:

| Fixture | Observed result |
| --- | --- |
| role + 3 or 127 reasoning chunks + final text + finish/usage | success, 1 header, final text received |
| role + 128 reasoning chunks + final text + finish/usage | `upstream_empty_response`, 0 headers, no answer, usage tail not reached |
| reasoning field of 66,000 ASCII characters before final text | same error, 0 headers |
| Anthropic nonempty text in `content_block_start` only | same error despite output tokens=3 |
| OpenAI full `choices[0].message` inside SSE rather than delta | same error despite output tokens=3 |
| complete JSON instead of SSE, including application/json header in transport replay | zero parsed SSE events; runner's empty check fails |
| non-streaming `content:[{type:'text',text:'FINAL ANSWER'}]` or `content:''` + nonempty refusal | canonical text empty, empty check true despite usage |
| UTF-8 emoji split midway through its four-byte sequence | original U+1F30D became three U+FFFD replacement characters |
| SSE JSON split across two `data:` lines | only last data line delivered, invalid JSON |
| clean EOF after text, no finish or DONE | transport returns success; runner currently fabricates DONE |

These prove source defects, not the exact payload of any real failed DeepSeek request. Production request ID, provider type, endpoint, streaming flag, upstream event shape/terminal status remain unobserved. Prioritize long-reasoning reproduction, then use structural diagnostics below to correlate. Never assume that output usage >0 implies an answer exists.

## Impact and proposed semantics

Callers from static source search: `routes/gateway/openai.ts:83,180`, `routes/gateway/anthropic.ts:61`, `routes/admin/models.ts:265,329`, `routes/admin/combos.ts:292`. `GatewayRunner.execute` sets `hardFailed`, records adaptive `error`, logs failed attempt and may retry/fallback after false empty (542–632). `empty_response` itself is not a provider-wide circuit failure (`isUpstreamHealthFailure`, 1359–1365). It can prevent a successful latency/recovery sample and fail a probe; it does not itself increment the slow counters. Actual retry dispatches and consumed input usage may increase. Keep circuit policy and adaptive selection algorithm intact.

**Proposed contract (decision for review):** a nonempty, valid, downstream-representable reasoning/thinking delta is generated content, distinct from final text. For a same-family client, forward it in its own original protocol field, commit on its first deliverable token, and stop the first-token and soft-response watchdogs; maintain hard total/idle/cancellation. The TTFT metric then means first deliverable generated token (including supported reasoning), not time to final answer; only completed valid generations teach adaptive latency. Track `hasAnswer` separately for diagnostics, never concatenate reasoning into final answer text. A properly terminated reasoning-only response with `length`/`max_tokens` is a valid truncated generation; preserve that finish reason. A reasoning-only normal stop with no final answer/tool can be recorded as incomplete when the expected contract requires an answer; do not relabel it as zero generation and do not retry after commitment. Define that rule consistently for both stream and non-stream. Signature-only/redacted thinking/role/usage/ping metadata is not a generated text token. If reasoning cannot be safely represented in the downstream protocol, do not count unforwarded content as commitment; use an explicit supported conversion or compatibility error. Do not invent a protocol mapping in this hotfix.

Changing TTFT from first answer/tool to first deliverable generation changes the meaning of recent reasoning samples. Document the change and keep existing TTL (15 min) rather than destructively clearing production history; if immediate sample isolation is needed, use a bounded workload version or existing supported reset after review. No global state reset. Preserve meaningful-output invariants in `docs/04`, `docs/10` and update combo help if necessary.

## P0 — eliminate false empty on supported output

### Task 1: pin the end-to-end regressions and fix reasoning/prelude

**Files:** `tests/integration/empty-upstream-output.test.ts`, `src/server/gateway/runner.ts` (923–1052); optionally new `src/server/protocols/generation.ts` for pure classifiers and `tests/unit/generation.test.ts`. Existing adaptive and upstream timeout tests remain authoritative.

- [ ] Add integration cases using the existing fixture helpers; add direct and combo variants, and verify actual client bytes, attempt rows, one upstream call, usage and final model. Example to insert in the existing describe (then use same fixture on `comboIds.openai`):

```ts
it('streams long reasoning and the complete answer without retry', async () => {
  const before = requestCount();
  const events = openaiEvents('text', 'long-reasoning');
  events.splice(1, 0, ...Array.from({ length: 140 }, () => ({
    payload: { id: 'long-reasoning', choices: [{ index: 0,
      delta: { reasoning_content: 'thinking ', content: null }, finish_reason: null }] },
  })));
  pushHandler((_req, res) => sse(res, events));
  const response = await request('openai', comboIds.openai, true);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('reasoning_content');
  expect(body).toContain('Recovered answer');
  expect(body).toContain('data: [DONE]');
  expect(callCount()).toBe(1);
  const row = await recordedRequestSince(before);
  expect(row).toMatchObject({ success: true, finalModelId: models.openai.first.id });
  expect(attemptRows(row.id)).toMatchObject([{ success: true, streamStarted: true }]);
});
```

- [ ] Add 64 KiB reasoning with realistic smaller deltas; first generated token arrives before soft threshold, answer after threshold; reasoning-only `length`, normal stop incomplete policy, reasoning followed by upstream error/disconnect (no fallback); empty strings, metadata-only and usage-only (must still fail). Anthropic `thinking_delta` plus later text and nonempty `content_block_start.text` are equivalent cases; preserve event names when forwarding. Keep legitimate zero-usage text/tool tests.
- [ ] CI red: `pnpm exec vitest run tests/integration/empty-upstream-output.test.ts` (new reasoning and block-start cases fail on baseline; existing tests pass).
- [ ] Implement small output predicates (`nonemptyString(v: unknown): v is string`, `hasDeliverableGeneration`, `hasAnswer`) for recognized validated fields. In current chunk handler, accumulate `textBuf` only from normalized text/refusal; do not put reasoning into it. Recognize known same-family `delta.reasoning_content`, Anthropic `thinking_delta.thinking` and `content_block_start` thinking/text where nonempty. Return `true` to transport only for actual committed generation, clearing both relevant watchdogs. Preserve ordering: queue only required initial metadata, commit once, flush in order, stream subsequent frames. Maintain actual UTF-8 byte cap (`Buffer.byteLength`) and count for required metadata; deduplicate safely redundant role/ping/usage events or reject unrepresentable/excessive prelude with distinct `upstream_bad_response` diagnostic `prelude_limit`, never claim empty solely because a buffer limit was crossed. Do not drop generated content to fit cap. A genuinely empty successfully terminated response still produces `upstream_empty_response`.
- [ ] Verify fragmented tool calls preserve IDs/arguments, do not turn empty placeholders into valid calls; check that a failed post-commit stream stays partial, a successful probe learns only after completion, and synthetic admin calls do not learn. CI green: same integration suite plus `tests/unit/upstream-timeouts.test.ts`, `tests/unit/combo-adaptive-state.test.ts`, `tests/integration/gateway.test.ts`. Commit focused P0 change after review.

### Task 2: normalize non-streaming and compatible SSE output shapes

**Files:** `src/server/protocols/canonical.ts:27–49,188–220`, `src/server/protocols/anthropic.ts:148–168`, `src/server/gateway/runner.ts:799–854,949–1007,1164–1243`, `routes/gateway/openai.ts`, `routes/gateway/anthropic.ts`; `tests/unit/canonical.test.ts`, `tests/integration/empty-upstream-output.test.ts`.

- [ ] Red tests: OpenAI content parts typed `text`/`output_text` joined in order; empty content plus nonempty refusal; content plus refusal keeps both semantic fields where representable; reasoning-only length preserved separately; missing usage valid content; legacy `function_call` / fragmented `tool_calls` only if valid; no choices with reported usage preserves accounting but remains empty/bad shape; unsupported or malformed blocks do not stringify to `[object Object]`. Assert same behavior on cache hit/replay, or bypass cache when extension cannot be faithfully stored. For Anthropic verify nonempty start-block text and absent/optional usage compatibility. For full-message-in-SSE fixture, ensure normalized downstream delta actually contains answer rather than simply recognizing a raw full message and claiming success.
- [ ] CI red: `pnpm exec vitest run tests/unit/canonical.test.ts tests/integration/empty-upstream-output.test.ts`.
- [ ] Share explicit known text extraction (`typeof content === 'string'` else array of validated typed parts) and refusal normalization, preserving separate reasoning/refusal where the protocol represents them. For example `const text = extractAssistantText(message.content); const refusal = nonemptyString(message.refusal) ? message.refusal : undefined;` then choose/preserve compatible fields, avoiding current `typeof content === 'string' ? content : refusal` bug when text is empty. Widen response type only for validated shapes. Update outcome serialization and cache representation together; do not cache an incomplete or lossy result. Retain non-stream full-body timing. Recognize complete-message SSE only via safe one-time normalization (never append repeated cumulative snapshots or invent deltas); unsupported layouts return clear compatibility/bad-response error.
- [ ] CI green: same suites, plus gateway and caching tests. Keep true empty HTTP 200 retry/fallback with current on5xx trigger and cap. Commit separately if shape support is larger than hotfix.

## P1 — SSE transport and completion reliability

### Task 3: repair SSE framing, decoding and content-type handling

**Files:** `src/server/upstream/client.ts:239–441`, `tests/unit/upstream-timeouts.test.ts`; optionally `src/server/upstream/sse.ts` and `tests/unit/upstream-sse.test.ts`.

- [ ] Red tests: split each byte of a multibyte UTF-8 character across chunks; multiline SSE JSON (`data:` fragments joined with newline), LF/CRLF/mixed line terminators and CR-only where supported, comments and keepalives, partial event at EOF, empty frame, `event:` field, bounded huge unframed payload. Verify actual concatenated output equals original, not just successful status. `stream=true` with `application/json` and valid chat body must not silently produce no events.
- [ ] Fix `decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })` (current `stream: streamDone` is reversed). Use an incremental SSE parser with line terminator handling and concatenation of all `data:` lines; retain exact event name, bound pending frame size in bytes, and handle decoder flush at EOF. Do not unconditionally trim content. Transport framing errors are `upstream_bad_response`, separate from genuinely empty generation. Preserve known HTTP status, hard deadlines and abort reasons.
- [ ] For non-SSE 2xx: inspect content-type (allow known compatible event-stream mislabel only with bounded sniffing); recognize a valid JSON completion and convert through the normalizer to protocol-correct stream events if supported, otherwise reject explicitly as `upstream_bad_response` with `unexpected_content_type`. Never pass raw JSON as SSE or return empty misleadingly. Bound JSON buffering by a documented size limit and existing deadline. Do not buffer a real streaming response.
- [ ] CI: run the upstream unit suite and empty-output/gateway integration suites; test both fetch reader cancellation and no cancellation on clean completion. Commit.

### Task 4: verify terminal semantics and add safe diagnostics

**Files:** `src/server/upstream/client.ts:335–381`, `src/server/gateway/runner.ts:923–1133,542–581`, `src/server/logging/debug.ts`, protocol tests and docs `03`, `04`, `10`, `13`.

- [ ] Red tests: finish + final usage + `[DONE]`; Anthropic `message_stop`; clean EOF after explicit finish (support providers that omit sentinel if finish is valid); premature EOF without finish or terminal marker; terminal with lingering open connection; error after first output; true empty metadata-only clean EOF. Ensure usage tail is collected before terminating; no extra downstream `[DONE]`/`message_stop`, no fake normal end or successful adaptive sample on truncation. Compatibility decision: tolerate clean EOF without terminal only if the provider's supported contract explicitly permits it; otherwise classify incomplete/bad response (partial after commit), not empty. A precommit no-content EOF remains an empty candidate when its body is well formed.
- [ ] Track terminal state independently of stream commitment; `callUpstreamStreaming` must expose meaningful terminal metadata or emit terminal events; `GatewayRunner` evaluates completion based on provider protocol. Stop consuming after authoritative terminal; do not wait for socket EOF after `[DONE]`/`message_stop`. Preserve all usage already received and upstream request ID/status even on precommit errors; differentiate actual HTTP 200 from gateway 502 in structured diagnostics. Maintain existing retry policy for genuinely empty vs invalid/truncated responses and no fallback after commit.
- [ ] Add structural diagnostic on failure, keyed by gateway request ID: provider protocol, client endpoint, upstream request ID, upstream status, content type, event count, prelude byte/count, recognized text/tool/reasoning counts, unknown shape counts, terminal seen/finish reason, first generated/answer latency if observed, error stage (`prelude_limit`, `no_generation_at_eof`, `unsupported_shape`, `truncated_stream`), commit flag, provider-reported usage. Do not log raw prompts, outputs, reasoning strings, headers/credentials or arbitrary untrusted keys. Replace current first-three raw stream-chunk debug with structural summary or apply existing documented opt-in privacy policy; never require raw body dumps for diagnosis. No DB migration needed for logs; preserve existing public error envelope and sanitized error summaries. If extending error codes, update classifier and UI display tests rather than treating them as provider-wide health failures.
- [ ] CI green: run focused unit/integration tests, existing synthetic admin and adaptive tests, then full `pnpm lint`, `pnpm typecheck`, `pnpm test`, build/critical e2e on GitHub Actions only. Review docs/04 TTFT and streaming rule, docs/10 acceptance, docs/13 diagnostic contract and combo UI help. Check git diff and GitNexus detect_changes before commit if available. Review/tag/deploy only after explicit implementation and release authorization; verify with real request IDs in deployed logs without replaying secrets or live DB edits.

## P2 — separately tracked compatibility gaps

Both `openaiStreamEncoder` and `anthropicStreamEncoder` at runner.ts:1553–1560 currently return the same `data:` wrapper, discarding the upstream `event:` label. They do not convert between upstream/client protocols. `/v1/responses` streaming uses that same chat encoder; non-stream route drops tool calls. These can lead to a client failing to read an otherwise successful response even when the empty check is fixed. Same-family event names/termination correctness should be covered in P0/P1; full cross-family canonical event translation and Responses stream envelopes need their own spec/fixtures and a separate PR. Avoid raw cross-protocol pass-through or claiming support where no safe mapping is available; handle unsupported combinations explicitly while preserving non-streaming behavior. No model-specific workaround in routing.

## Acceptance and execution handoff

1. The long reasoning fixture returns the full answer exactly once, with a single successful attempt, correct usage/finish, no fallback and no false health/adaptive errors. Short reasoning behavior remains correct. TTFT measures actual deliverable generation; metadata alone never clears first-token/soft timeout.
2. Supported output shapes, zero/missing usage, legitimate tools/refusal, and safe reasoning/truncation semantics return protocol-correct data. Truly empty or malformed responses remain failures with accurate code and bounded retry/fallback. Legacy cached empty successes are still evicted.
3. True stream truncation/disconnect after commitment is partial; no fabricated clean terminal, duplicate model output, unexpected retries or false successful learning. UTF-8 and SSE multiline/chunk boundaries preserve exact content; memory/deadlines remain bounded.
4. Diagnostics distinguish all error stages and correlate request/upstream IDs without raw contents. CI checks pass. No local heavy tests, no live database changes, no production edits or release in this investigation.

Implement Task 1 first as a small urgent PR, then Task 2 and P1 in independently reviewable commits. Do not delay the reasoning fix for a full protocol rewrite. Confirm production correlation using redacted structural logs from an actual failing request before declaring the incident fully resolved.

## Implementation checkpoint

P0/P1 code and regression fixtures are present. Same-family reasoning commits on the first generated token; the parser distinguishes genuine empty, unsupported, incomplete and truncated streams. Complete OpenAI JSON chat snapshots can be normalized into a stream with a 1 MiB body limit. P2 translation remains out of scope. Cache writes are bypassed where reasoning/refusal/legacy extensions would be lost. No database migration or state reset is required.

Local lightweight checks: canonical and SSE unit suites passed (31/31); extracted runner replays passed, including the original long-reasoning boundary and latest JSON snapshot/tool/empty/truncation cases. Full integration, typecheck, build and Docker smoke remain GitHub CI gates. The GitNexus workspace graph predates v2.0.0; its detect-changes result is critical, consistent with modifying shared gateway paths, and is not a fresh-graph guarantee. No real upstream or production database was accessed.
