import { describe, expect, it, vi } from 'vitest';
import { POOLED_PROVIDER_TYPES, getPooledProvider, pooledProviderDefaults } from '../../src/server/providers/pooled';

vi.mock('../../src/server/db/repositories/codex-accounts', () => ({
  listCodexAccountSummaries: vi.fn(() => [{ id: 'acct-1', enabled: true, healthState: 'healthy' }]),
}));
vi.mock('../../src/server/providers/codex', () => ({
  probeCodex: vi.fn(async () => ({ ok: true, detail: 'Connected (200)', latencyMs: 5, modelCount: 3 })),
  codexModels: vi.fn(async () => [{ upstreamId: 'gpt-5-codex', displayName: 'gpt-5-codex', capabilities: { responses: true } }]),
  CODEX_BASE_URL: 'https://chatgpt.com',
}));
vi.mock('../../src/server/providers/codex-refresh', () => ({
  withCodexCredentials: vi.fn(async (_id: string, fn: (c: unknown) => unknown) => fn({ accessToken: 'tok', refreshToken: 'r', idToken: null })),
  codexCredentialError: vi.fn((e: unknown) => e),
}));

describe('account-pool provider registry', () => {
  it('claims only account-pool types', () => {
    expect(POOLED_PROVIDER_TYPES).toContain('codex');
    expect(getPooledProvider('openai')).toBeNull();
    expect(getPooledProvider('anthropic')).toBeNull();
    expect(getPooledProvider('codex')).not.toBeNull();
  });

  it('owns the provider defaults of an account-pool type', () => {
    expect(pooledProviderDefaults('codex')).toEqual({ name: 'Codex', slug: 'codex', baseUrl: 'https://chatgpt.com' });
  });

  it('lists eligible accounts through the strategy', () => {
    expect(getPooledProvider('codex')?.listAccounts('provider-1')).toEqual([{ id: 'acct-1', enabled: true, healthState: 'healthy' }]);
  });

  it('fails closed when a pool provider has no eligible account', async () => {
    const { listCodexAccountSummaries } = await import('../../src/server/db/repositories/codex-accounts');
    vi.mocked(listCodexAccountSummaries).mockReturnValueOnce([]);
    await expect(getPooledProvider('codex')!.probe({ id: 'p', baseUrl: 'https://chatgpt.com', totalTimeoutMs: 1000 })).rejects.toThrow('No eligible account');
  });
});
