import { describe, expect, it, vi } from 'vitest';
import { providerToUpstreamConfig } from '../../src/server/upstream/client';

vi.mock('../../src/server/db/repositories/codex-accounts', () => ({
  getCodexAccountForProvider: vi.fn(() => ({ id: 'account-row-1', chatgptAccountId: 'chatgpt-account-1' })),
}));

describe('Codex provider dispatch configuration', () => {
  it('builds an account-backed Codex config instead of rejecting the provider', () => {
    const config = providerToUpstreamConfig({
      id: 'provider-1', name: 'Codex', slug: 'codex', type: 'codex', baseUrl: 'https://chatgpt.com',
      encryptedApiKey: null, apiKeyNonce: null, apiKeyVersion: 1,
      customHeadersEncrypted: null, customHeadersNonce: null, enabled: true,
      connectTimeoutMs: 1000, firstTokenTimeoutMs: 1000, streamIdleTimeoutMs: 1000, totalTimeoutMs: 1000,
      maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, cbFailureThreshold: 1, cbCooldownSeconds: 1,
      healthState: 'unknown', createdAt: '', updatedAt: '',
    });
    expect(config).toMatchObject({ type: 'codex', accountRecordId: 'account-row-1', codexAccountId: 'chatgpt-account-1' });
    expect(config).not.toHaveProperty('apiKey');
  });
});
