import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/db/repositories/qoder-accounts', () => ({
  findEligibleQoderAccount: vi.fn(() => ({ id: 'qacct-1', qoderUserId: 'user-9' })),
}));

import { providerToUpstreamConfig } from '../../src/server/upstream/client';

const providerRow = {
  id: 'provider-1', name: 'Qoder', slug: 'qoder', type: 'qoder', baseUrl: 'https://api2.qoder.sh',
  encryptedApiKey: null, apiKeyNonce: null, apiKeyVersion: 1,
  customHeadersEncrypted: null, customHeadersNonce: null, enabled: true,
  connectTimeoutMs: 1000, firstTokenTimeoutMs: 1000, streamIdleTimeoutMs: 1000, totalTimeoutMs: 1000,
  maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, cbFailureThreshold: 1, cbCooldownSeconds: 1,
  healthState: 'unknown', createdAt: '', updatedAt: '',
};

describe('Qoder provider dispatch configuration', () => {
  it('builds an account-backed Qoder config with no API key', () => {
    const config = providerToUpstreamConfig(providerRow as never);
    expect(config).toMatchObject({ type: 'qoder', qoderAccountRecordId: 'qacct-1', qoderUserId: 'user-9' });
    expect(config).not.toHaveProperty('apiKey');
  });

  it('fails closed when the provider has no eligible account', async () => {
    const repo = await import('../../src/server/db/repositories/qoder-accounts');
    vi.mocked(repo.findEligibleQoderAccount).mockReturnValueOnce(null);
    expect(() => providerToUpstreamConfig(providerRow as never)).toThrow('No usable Qoder account');
  });
});
