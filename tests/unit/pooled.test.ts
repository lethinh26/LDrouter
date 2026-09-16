import { describe, expect, it, vi } from 'vitest';
import { POOLED_PROVIDER_TYPES, getPooledProvider, pooledProviderDefaults } from '../../src/server/providers/pooled';

vi.mock('../../src/server/db/repositories/codex-accounts', () => ({
  listCodexAccountSummaries: vi.fn(() => [{ id: 'acct-1', enabled: true, healthState: 'healthy' }]),
  chatgptAccountIdOf: vi.fn(() => 'chatgpt-acct-1'),
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

vi.mock('../../src/server/db/repositories/qoder-accounts', () => ({
  listQoderAccountSummaries: vi.fn(() => [{ id: 'qacct-1', enabled: true, healthState: 'healthy' }]),
}));
vi.mock('../../src/server/providers/qoder/client', () => ({
  probeQoder: vi.fn(async () => ({ ok: true, detail: 'Connected (catalog loaded)', latencyMs: 7, modelCount: 2 })),
  qoderModels: vi.fn(() => [{ upstreamId: 'qmodel_38max', displayName: 'Qwen3.8-Max', capabilities: { chat: true } }]),
}));
vi.mock('../../src/server/providers/qoder/credentials', () => ({
  withQoderCredentials: vi.fn(async (_id: string, fn: (c: unknown) => unknown) => fn({ qoderUserId: 'u1', jobToken: 'jt-1', machineId: 'm1', catalog: { entries: new Map(), fetchedAt: '' }, email: null, label: null })),
}));

describe('account-pool provider registry', () => {
  it('claims only account-pool types', () => {
    expect(POOLED_PROVIDER_TYPES).toContain('codex');
    expect(POOLED_PROVIDER_TYPES).toContain('qoder');
    expect(getPooledProvider('openai')).toBeNull();
    expect(getPooledProvider('anthropic')).toBeNull();
    expect(getPooledProvider('codex')).not.toBeNull();
    expect(getPooledProvider('qoder')).not.toBeNull();
  });

  it('owns the Qoder provider defaults', () => {
    expect(pooledProviderDefaults('qoder')).toEqual({ name: 'Qoder', slug: 'qoder', baseUrl: 'https://api2.qoder.sh' });
  });

  it('lists Qoder accounts through the Qoder strategy', async () => {
    expect(getPooledProvider('qoder')?.listAccounts('provider-1')).toEqual([{ id: 'qacct-1', enabled: true, healthState: 'healthy' }]);
    const { listQoderAccountSummaries } = await import('../../src/server/db/repositories/qoder-accounts');
    expect(vi.mocked(listQoderAccountSummaries)).toHaveBeenCalledWith('provider-1');
  });

  it('fails closed when a Qoder provider has no eligible account', async () => {
    const { listQoderAccountSummaries } = await import('../../src/server/db/repositories/qoder-accounts');
    vi.mocked(listQoderAccountSummaries).mockReturnValueOnce([]);
    await expect(getPooledProvider('qoder')!.probe({ id: 'p', baseUrl: 'https://api2.qoder.sh', totalTimeoutMs: 1000 })).rejects.toThrow('No eligible account');
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

  it('passes the stored chatgpt account id to the upstream call', async () => {
    // Account selection is the only gate; the id is an unconditional column read, so an account the
    // old `getCodexAccountById` would have rejected (degraded / expired token) still reaches upstream.
    const { probeCodex } = await import('../../src/server/providers/codex');
    const { chatgptAccountIdOf } = await import('../../src/server/db/repositories/codex-accounts');
    await getPooledProvider('codex')!.probe({ id: 'p', baseUrl: 'https://chatgpt.com', totalTimeoutMs: 1000 });
    expect(vi.mocked(probeCodex).mock.calls[0]?.[0]).toMatchObject({ accountId: 'chatgpt-acct-1', accountRecordId: 'acct-1' });
    expect(vi.mocked(chatgptAccountIdOf)).toHaveBeenCalledWith('acct-1');
  });
});
