// Unit tests: combo routing — capability filtering, fallback decision, ordering.
import { describe, expect, it } from 'vitest';
import { selectCandidates, orderCandidates, shouldFallback, type ComboPlan, type CandidateModel } from '../../src/server/routing/combo';
import type { RequiredCapabilities } from '../../src/server/routing/capabilities';

const combo = (mode: 'fallback' | 'weighted_round_robin'): ComboPlan => ({
  comboId: 'c1',
  mode,
  maxTotalAttempts: 3,
  members: [
    { id: 'm1', modelId: 'a', position: 1, weight: 5, enabled: true },
    { id: 'm2', modelId: 'b', position: 2, weight: 3, enabled: true },
    { id: 'm3', modelId: 'c', position: 3, weight: 2, enabled: true },
  ],
  trigger: { connection: true, connectTimeout: true, firstTokenTimeout: true, on408: true, on429: true, on5xx: true },
});

const candidates: CandidateModel[] = [
  { modelId: 'a', publicModelId: 'p1/m-a', providerId: 'p1', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: { chat: true, streaming: true, tools: true } },
  { modelId: 'b', publicModelId: 'p1/m-b', providerId: 'p1', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: { chat: true, streaming: true, tools: false } },
  { modelId: 'c', publicModelId: 'p2/m-c', providerId: 'p2', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: { chat: true, streaming: true, tools: true } },
];

describe('combo routing', () => {
  it('filters capability-incompatible members', () => {
    const req: RequiredCapabilities = { streaming: false, tools: true, structuredOutput: false, imageInput: false, audioInput: false, reasoning: false, responses: false };
    const out = selectCandidates(combo('fallback'), candidates, req);
    expect(out.map((c) => c.modelId)).toEqual(['a', 'c']); // b lacks tools
  });

  it('filters disabled / unavailable / circuit-open', () => {
    const req: RequiredCapabilities = { streaming: false, tools: false, structuredOutput: false, imageInput: false, audioInput: false, reasoning: false, responses: false };
    const broken: CandidateModel[] = [
      { ...candidates[0]!, enabled: false },
      { ...candidates[1]!, upstreamAvailable: false },
      { ...candidates[2]!, circuitOpen: true },
    ];
    const out = selectCandidates(combo('fallback'), broken, req);
    expect(out.length).toBe(0);
  });

  it('fallback keeps declared order', () => {
    const req: RequiredCapabilities = { streaming: false, tools: false, structuredOutput: false, imageInput: false, audioInput: false, reasoning: false, responses: false };
    const out = orderCandidates(combo('fallback'), selectCandidates(combo('fallback'), candidates, req));
    expect(out.map((c) => c.modelId)).toEqual(['a', 'b', 'c']);
  });

  it('weighted round robin rotates deterministically', () => {
    const req: RequiredCapabilities = { streaming: false, tools: false, structuredOutput: false, imageInput: false, audioInput: false, reasoning: false, responses: false };
    const plan = combo('weighted_round_robin');
    const first = orderCandidates(plan, selectCandidates(plan, candidates, req));
    const second = orderCandidates(plan, selectCandidates(plan, candidates, req));
    const third = orderCandidates(plan, selectCandidates(plan, candidates, req));
    expect(first[0]!.modelId).not.toBe(second[0]!.modelId);
    expect(second[0]!.modelId).not.toBe(third[0]!.modelId);
  });

  it('fallback decision matrix', () => {
    const plan = combo('fallback');
    expect(shouldFallback(plan, { type: 'connection_error' })).toBe(true);
    expect(shouldFallback(plan, { type: 'http_status', status: 429 })).toBe(true);
    expect(shouldFallback(plan, { type: 'http_status', status: 503 })).toBe(true);
    expect(shouldFallback(plan, { type: 'http_status', status: 400 })).toBe(false);
    expect(shouldFallback(plan, { type: 'stream_partial' })).toBe(false); // never after content sent
    const no429 = { ...plan, trigger: { ...plan.trigger, on429: false } };
    expect(shouldFallback(no429, { type: 'http_status', status: 429 })).toBe(false);
  });
});
