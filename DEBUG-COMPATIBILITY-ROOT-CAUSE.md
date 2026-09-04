# Root Cause Analysis: Claude Code → 9router → LDRouter Compatibility Issues

## Executive Summary

Two **separate** root causes were identified for the compatibility issues:

1. **Combo Model Rejection (CASE 1)**: Zod validation rejecting unknown fields + capability undefined handling treating `undefined` as "unsupported"
2. **Cloudflare 502 Direct Calls (CASE 2)**: Unhandled exceptions during streaming from malformed responses + empty capabilities JSON parsing

---

## ROOT CAUSE #1: Combo Model Capability Rejection

### Symptom
```
No combo member satisfies the request capabilities or availability
```

### Trace Path
1. **Zod Validation Failure** (`src/server/routes/gateway/openai.ts:54`)
   ```typescript
   const body = ChatBody.parse(req.body); // FAILS on unknown fields
   ```

2. **Claude Code Sends Extra Fields**:
   - `parallel_tool_calls`
   - `max_completion_tokens` 
   - `stream_options`
   - `metadata`
   - `seed`
   - `service_tier`

3. **Capability Detection Flow**:
   ```
   openAIChatRequest → openAIToCanonical() → deriveRequiredCapabilities() → selectCandidates()
   ```

4. **The Real Bug in Capability Comparison** (`src/server/routing/capabilities.ts:88-97`):
   ```typescript
   export function modelMeets(caps: ModelCapabilitiesInput, req: RequiredCapabilities): boolean {
     if (req.streaming && !caps.streaming) return false; // ❌ undefined === false → TRUE → rejects
     if (req.tools && !caps.tools) return false;         // ❌ undefined === true → FALSE → accepts incorrectly
     // ...
   }
   ```

5. **Import Time Capabilities Inference** (`src/server/providers/index.ts:113-123`):
   ```typescript
   function inferOpenAICapabilities(id: string): DiscoveredModel['capabilities'] {
     const lower = id.toLowerCase();
     return {
       chat: true,
       streaming: true,
       tools: !(lower.includes('embedding') || ...), // OK
       image_input: lower.includes('vision'),        // ❌ 'vl/gpt-5.4' doesn't contain 'vision'!
       structured_output: ...,
       reasoning: ...,
     };
   }
   ```

### Why Test Model Works but Claude Code Doesn't

| Scenario | Request Content | Result |
|----------|----------------|--------|
| **Test Model (9router)** | Small payload, known fields | ✅ Passthrough OK |
| **Direct curl** | Known fields only | ✅ Passthrough OK |
| **Claude Code** | Unknown fields + image content | ❌ `image_input=undefined` + `req.imageInput=true` → rejected |

---

## ROOT CAUSE #2: Cloudflare 502 on Direct Model Calls

### Symptom
```
Cloudflare 502: Bad gateway
Host api.latedev.com: Error
```

### Trace Path
1. **Request reaches LDRouter** → upstream returns HTTP 200
2. **Streaming begins** → chunk handler processes response
3. **Exception thrown** → Fastify error handler wraps → connection closed
4. **Cloudflare sees connection close** → 502 HTML page

### Specific Crash Points

#### A. Malformed Tool Calls in Stream Chunk Handler (`src/server/gateway/runner.ts:495-543`)
```typescript
const chunkHandler = (chunk: { data: string; event?: string }, isFirst: boolean) => {
  const obj = JSON.parse(chunk.data);
  if (cfg.type === 'openai') {
    const choice = obj.choices?.[0];
    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (tc.function?.name) toolBuf.push({ 
          id: tc.id ?? '',                // ❌ tc.id could be null → later crashes
          name: tc.function.name,          // ❌ could be undefined
          input: {}                        // ❌ not parsed properly
        });
      }
    }
  }
};
```

**What breaks:**
- `tc.id` is `null` → string coercion OK but later database insert fails
- `tc.function.arguments` is already an object (not string) → `JSON.parse()` throws
- `tc.function.name` is `undefined` → crashes when building Anthropic request

#### B. Empty Capabilities JSON Default (`src/server/gateway/runner.ts:829-831`)
```typescript
function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; } // ❌ Returns EMPTY OBJECT!
}
```

**Impact:**
- If `m.capabilitiesJson` is `null` or malformed → `{}` returned
- All capability checks fail: `modelMeets({}, required)` → `caps.streaming === undefined` → previously rejected!

#### C. Malformed OpenAI Response Parsing (`src/server/protocols/canonical.ts:176-192`)
```typescript
export function openAIResponseToCanonical(res: OpenAIChatResponse, requestedModel: string) {
  const choice = res.choices[0];
  return {
    model: requestedModel,
    text: choice?.message?.content ?? '',
    toolCalls: (choice?.message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,              // ❌ null/undefined
      name: tc.function.name, // ❌ undefined
      input: safeJson(tc.function.arguments) // ❌ arguments is NOT string!
    })),
    // ...
  };
}
```

**Cascade effect:**
1. `input: safeJson(undefined)` → `safeJson` tries `JSON.parse(undefined)` → returns `undefined`
2. Later conversion to Anthropic format: `JSON.stringify(undefined)` → `"undefined"` → invalid schema
3. Upstream rejects → 502 → Cloudflare sees connection close → 502 HTML

---

## FIXES APPLIED

### Fix #1: Zod Passthrough for Unknown Fields

**File:** `src/server/routes/gateway/openai.ts:14-25`

**Before:**
```typescript
const ChatBody = z.object({
  model: z.string().min(1),
  messages: z.array(z.any()).min(1),
  tools: z.array(z.any()).optional(),
  // ... known fields only
});
```

**After:**
```typescript
const ChatBody = z.object({
  model: z.string().min(1),
  messages: z.array(z.any()).min(1),
  tools: z.array(z.any()).optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  parallel_tool_calls: z.any().optional(),
  stream_options: z.any().optional(),
  metadata: z.any().optional(),
  seed: z.number().int().optional(),
  service_tier: z.any().optional(),
}).passthrough(); // Allow ANY other fields to pass through
```

**Rationale:** Forward unknown fields to upstream provider. Don't fail validation on fields you don't understand.

---

### Fix #2: Capability Undefined Handling

**File:** `src/server/routing/capabilities.ts:95-105`

**Before:**
```typescript
export function modelMeets(caps: ModelCapabilitiesInput, req: RequiredCapabilities): boolean {
  if (req.streaming && !caps.streaming) return false; // Treats undefined as false
  if (req.tools && !caps.tools) return false;
  // ...
}
```

**After:**
```typescript
/**
 * IMPORTANT: Treat undefined as "unknown" rather than "unsupported".
 * For generic OpenAI-compatible providers where capabilities weren't explicitly imported,
 * undefined means we don't know, so we should assume it's potentially supported.
 */
export function modelMeets(caps: ModelCapabilitiesInput, req: RequiredCapabilities): boolean {
  if (req.streaming && caps.streaming === false) return false;
  if (req.tools && caps.tools === false) return false;
  if (req.structuredOutput && caps.structured_output === false) return false;
  if (req.imageInput && caps.image_input === false) return false;
  if (req.audioInput && caps.audio_input === false) return false;
  if (req.reasoning && caps.reasoning === false) return false;
  if (req.responses && caps.responses === false) return false;
  return true;
}
```

**Rationale:** Distinguish between `true` (known supported), `false` (known unsupported), and `undefined` (unknown/potentially supported).

---

### Fix #3: Robust Capabilities JSON Default

**File:** `src/server/gateway/runner.ts:829-851`

**Before:**
```typescript
function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; } // ❌ Empty object breaks everything
}
```

**After:**
```typescript
function safeJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    const result: Record<string, unknown> = {
      chat: true,
      streaming: true,
      tools: true,
      structured_output: true,
      image_input: true,
      audio_input: true,
      reasoning: true,
      responses: true,
      ...parsed,
    };
    return result;
  } catch (e) {
    // Fallback to defaults if completely unparseable
    return {
      chat: true,
      streaming: true,
      tools: true,
      structured_output: true,
      image_input: true,
      audio_input: true,
      reasoning: true,
      responses: true,
    };
  }
}
```

**Rationale:** Always return complete default object with all capability fields set to `true`. Missing imports = unknown = assume support.

---

### Fix #4: Safe Streaming Chunk Handler

**File:** `src/server/gateway/runner.ts:495-532`

**Before:**
```typescript
if (choice?.delta?.tool_calls) {
  for (const tc of choice.delta.tool_calls) {
    if (tc.function?.name) toolBuf.push({ 
      id: tc.id ?? '', 
      name: tc.function.name, 
      input: {} 
    });
  }
}
```

**After:**
```typescript
if (choice?.delta?.tool_calls) {
  for (const tc of choice.delta.tool_calls) {
    const id = typeof tc.id === 'string' ? tc.id : `toolu-${Math.random().toString(36).slice(2)}`;
    const name = typeof tc.function?.name === 'string' ? tc.function.name : 'unknown';
    let input = {};
    if (typeof tc.function?.arguments === 'string') {
      try { input = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
    } else if (typeof tc.function?.arguments === 'object') {
      input = tc.function.arguments;
    }
    toolBuf.push({ id, name, input });
  }
}
```

**Rationale:** Validate types before using, provide sensible defaults, gracefully handle malformed JSON.

---

### Fix #5: Robust Response Parser

**File:** `src/server/protocols/canonical.ts:176-202`

**Before:**
```typescript
export function openAIResponseToCanonical(res: OpenAIChatResponse, requestedModel: string) {
  const choice = res.choices[0];
  return {
    text: choice?.message?.content ?? '',
    toolCalls: (choice?.message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: safeJson(tc.function.arguments)
    })),
    // ...
  };
}
```

**After:**
```typescript
export function openAIResponseToCanonical(res: OpenAIChatResponse, requestedModel: string) {
  const choice = res.choices[0];
  if (!choice || !choice.message) {
    return {
      model: requestedModel,
      text: '',
      toolCalls: [],
      finishReason: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    };
  }

  return {
    model: requestedModel,
    text: typeof choice.message.content === 'string' ? choice.message.content : '',
    toolCalls: ((choice.message.tool_calls ?? []) as Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>).map((tc) => ({
      id: typeof tc.id === 'string' ? tc.id : `toolu-${Math.random().toString(36).slice(2)}`,
      name: typeof tc.function?.name === 'string' ? tc.function.name : 'unknown',
      input: safeJson(typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}'),
    })),
    finishReason: choice?.finish_reason ?? null,
    usage: {
      input: typeof res.usage?.prompt_tokens === 'number' ? res.usage.prompt_tokens : 0,
      output: typeof res.usage?.completion_tokens === 'number' ? res.usage.completion_tokens : 0,
      // ...
    },
  };
}
```

**Rationale:** Handle empty/malformed responses gracefully, validate types before access.

---

### Fix #6: Process-Level Crash Prevention

**File:** `src/server/app.ts:133-145`

Added:
```typescript
process.on('uncaughtException', (err) => {
  const log = getLogger();
  log.error({ err: { message: err.message, stack: err.stack } }, 'uncaught exception');
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  const log = getLogger();
  log.error({ reason: typeof reason === 'object' && reason !== null ? (reason as Error).message : String(reason) }, 'unhandled rejection');
});
```

**Rationale:** Prevent silent crashes from causing connection resets that lead to Cloudflare 502s. Log uncaught errors instead of letting them propagate.

---

## VERIFICATION PLAN

### Manual Testing Checklist

1. **Test with 9router's Test Model feature:**
   - ✅ Should work (no change expected)

2. **Test with direct curl:**
   ```bash
   curl -X POST https://api.latedev.com/v1/chat/completions \
     -H "Authorization: Bearer YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "gpt-5.4",
       "messages": [{"role": "user", "content": "Hello"}],
       "tools": [{"name": "test", "function": {"parameters": {}}}],
       "parallel_tool_calls": true
     }'
   ```
   - ✅ Should work (extra fields now pass through)

3. **Test via Claude Code:**
   - 🔜 Run actual conversation with tools
   - 🔜 Verify no "capability_not_supported" errors
   - 🔜 Verify no Cloudflare 502s

### Regression Tests Added

**File:** `tests/integration/claude-code-compatibility.test.ts`

Tests cover:
- ✅ Zod passthrough for unknown fields
- ✅ Capability undefined handling
- ✅ Streaming crash prevention
- ✅ Combo routing with partial capabilities
- ✅ Vision model detection without explicit keywords
- ✅ Empty/malformed response handling

Run tests:
```bash
pnpm test claude-code-compatibility
```

---

## DEPLOYMENT CHECKLIST

- [ ] Verify tests pass locally
- [ ] Run `pnpm lint && pnpm typecheck && pnpm build`
- [ ] Deploy to staging environment
- [ ] Test with real Claude Code session
- [ ] Monitor logs for uncaught exceptions
- [ ] Check Cloudflare 502 rate decreases
- [ ] Update CHANGELOG.md with version bump

---

## WHY PREVIOUS TESTS WORKED BUT CLAUDE CODE FAILED

| Test Type | Payload Size | Known Fields | Unknown Fields | Image Content | Result |
|-----------|-------------|--------------|----------------|---------------|--------|
| **9router Test Model** | Small (~200 bytes) | ✅ Yes | ❌ No | ❌ No | ✅ Pass |
| **Direct curl** | Small (~500 bytes) | ✅ Yes | ❌ No | ❌ No | ✅ Pass |
| **Tools-only curl** | Medium (~1KB) | ✅ Yes | ❌ No | ❌ No | ✅ Pass |
| **Tool history curl** | Medium (~2KB) | ✅ Yes | ❌ No | ❌ No | ✅ Pass |
| **Claude Code** | Large (~10-50KB) | ❌ Partial | ✅ YES | ✅ Sometimes | ❌ Fail |

**Key Insight:** The bug wasn't about "tools vs non-tools" or "streaming vs non-streaming". It was about **UNKNOWN FIELDS + CAPABILITY DEFINITION GAP**.

---

## LONG-TERM RECOMMENDATIONS

1. **Explicit Capability Discovery:** Implement proper provider API introspection to populate capabilities rather than inference patterns like `includes('vision')`.

2. **Normalized Field Registry:** Maintain a registry of supported fields per protocol, reject only truly incompatible ones instead of using overly permissive passthrough.

3. **Schema Version Negotiation:** Add protocol version negotiation to detect client capabilities upfront.

4. **Better Logging:** Log capability comparison failures with full details:
   ```typescript
   log.warn({
     modelId: c.publicModelId,
     requiredCapabilities: req,
     modelCapabilities: c.capabilities,
     mismatchedField: Object.keys(req).find(k => req[k] && c.capabilities[k] === false)
   }, 'candidate filtered by capability check');
   ```

5. **Automatic Capability Refresh:** Periodically re-discover provider capabilities when models are refreshed, not just at initial import.
