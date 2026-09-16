import { describe, expect, it } from 'vitest';
import { expandQoderAccountCandidates, type QoderAccountCandidate } from '../../src/server/routing/combo';

const candidate = { modelId: 'm1', providerId: 'qp', publicModelId: 'qoder/qmodel_38max', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {}, providerType: 'qoder' };
const accounts: QoderAccountCandidate[] = [
  { id: 'b', qoderUserId: 'u2', enabled: true, healthState: 'healthy', priority: 2 },
  { id: 'a', qoderUserId: 'u1', enabled: true, healthState: 'healthy', priority: 1 },
  { id: 'c', qoderUserId: 'u3', enabled: false, healthState: 'healthy', priority: 0 },
  { id: 'd', qoderUserId: 'u4', enabled: true, healthState: 'down', priority: 0 },
];

describe('Qoder account candidate expansion', () => {
  it('yields one candidate per eligible account in priority order', () => {
    expect(expandQoderAccountCandidates(candidate, accounts).map((c) => c.qoderAccountId)).toEqual(['a', 'b']);
  });

  it('leaves a non-Qoder model untouched', () => {
    const other = { ...candidate, providerType: 'openai', publicModelId: 'openai/gpt-test' };
    expect(expandQoderAccountCandidates(other, accounts)).toEqual([other]);
  });

  it('respects the provider type rather than a hardcoded slug prefix', () => {
    // A Qoder provider whose slug is not literally `qoder` still expands.
    const custom = { ...candidate, publicModelId: 'my-qoder/qmodel_38max' };
    expect(expandQoderAccountCandidates(custom, accounts).map((c) => c.qoderAccountId)).toEqual(['a', 'b']);
  });

  it('keeps a degraded account eligible and drops only down or disabled ones', () => {
    // degraded is a warning (a previous billing/quota block), not a verdict: the runner retries it.
    const mixed = [...accounts, { id: 'e', qoderUserId: 'u5', enabled: true, healthState: 'degraded', priority: 3 }];
    expect(expandQoderAccountCandidates(candidate, mixed).map((c) => c.qoderAccountId)).toEqual(['a', 'b', 'e']);
  });
});
