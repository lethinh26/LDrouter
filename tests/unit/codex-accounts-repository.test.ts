import { describe, expect, it } from 'vitest';
import { identityFromCodexRecord, maskCodexValue, toCodexAccountSummary } from '../../src/server/db/repositories/codex-accounts';

const record = {
  index: 0,
  email: 'user@example.com',
  workspaceId: 'workspace-123456',
  chatgptAccountId: 'account-123456',
  planType: 'plus',
  expiresAt: '2026-10-01T00:00:00.000Z',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  idToken: 'id-secret',
  identity: 'account:account-123456',
};

describe('Codex account repository projections and identity', () => {
  it('uses account, then workspace, then token identity without email-only merging', () => {
    expect(identityFromCodexRecord(record)).toMatchObject({ chatgptAccountId: 'account-123456', workspaceId: 'workspace-123456', email: 'user@example.com', tokenDigest: expect.any(String) });
    expect(identityFromCodexRecord({ ...record, chatgptAccountId: null })).toMatchObject({ workspaceId: 'workspace-123456' });
    expect(identityFromCodexRecord({ ...record, chatgptAccountId: null, workspaceId: null })).toMatchObject({ tokenDigest: expect.any(String) });
  });

  it('returns summaries that contain no credential fields or values', () => {
    const summary = toCodexAccountSummary({
      id: 'account-1', email: record.email, workspaceId: record.workspaceId,
      chatgptAccountId: record.chatgptAccountId, planType: record.planType, tokenExpiresAt: record.expiresAt,
      enabled: true, healthState: 'unknown', lastRefreshAt: null, priority: 0, createdAt: '2026-01-01', updatedAt: '2026-01-02',
    });
    const text = JSON.stringify(summary);
    expect(text).not.toContain('secret');
    expect(summary).toMatchObject({ id: 'account-1', email: 'user@example.com', accountIdMasked: 'acco…3456' });
    expect(maskCodexValue(null)).toBeNull();
  });
});
