import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/server/errors';
import { classifyFailure, isCredentialFailure, isPermanentCredentialFailure, markCredentialsDead, shouldRetryAttempt } from '../../src/server/gateway/runner';
import { expandCodexAccountCandidates } from '../../src/server/routing/combo';
import { codexCredentialError } from '../../src/server/providers/codex-refresh';

/**
 * A dead refresh token is a durable, account-level verdict — the same class as quota exhaustion.
 *
 * Live evidence (production, 2026-09-19): two accounts holding invalidated refresh tokens sat at
 * the head of the pool (Auth0 answers `refresh_token_invalidated`, "Your session has ended"),
 * so every `codex1/…` request landed on one of them. Each surfaced as `oauth_refresh_failed`,
 * classified `unknown`, `attempts_count=1` — a 502 straight to the client while healthy accounts
 * sat idle behind them. 226 of 241 failed requests had exactly one attempt.
 *
 * `unknown` is not a routing decision: `shouldFallback` returns false for it, so the pool kept
 * selecting the dead account and never spent an attempt on a sibling.
 */

/** Exactly what `withCodexCredentials` throws, as re-wrapped by the runner's catch. */
const rawDeadCredential = () => {
  const thrown = new Error('oauth_refresh_failed', { cause: new Error('oauth_refresh_failed') });
  return new GatewayError('upstream_error', thrown.message, { status: 502, cause: thrown });
};

/** The same failure where the call site wrapped it first (admin surface, pooled probe). */
const wrappedDeadCredential = () => codexCredentialError(new Error('oauth_refresh_failed')) as GatewayError;

describe('credential failure classification', () => {
  it('classifies a dead refresh token as credential, not unknown', () => {
    expect(classifyFailure(rawDeadCredential())).toBe('credential');
  });

  it('still recognises the code when the call site wrapped the error first', () => {
    const wrapped = wrappedDeadCredential();
    expect(isCredentialFailure(wrapped)).toBe(true);
    expect(classifyFailure(wrapped)).toBe('credential');
  });

  it('recognises every credential code the layer can throw', () => {
    for (const code of ['oauth_refresh_failed', 'invalid_refresh_response', 'credential_unavailable', 'account_not_found']) {
      expect(isCredentialFailure(new GatewayError('upstream_error', code, { status: 502 }))).toBe(true);
    }
  });

  it('does not misread an ordinary upstream failure as a credential failure', () => {
    // A 401 from the upstream itself is a *different* verdict: the account may still be fine.
    expect(isCredentialFailure(new GatewayError('upstream_auth_error', 'Upstream authentication failed (HTTP 403)', { status: 502 }))).toBe(false);
    expect(isCredentialFailure(new GatewayError('upstream_error', 'Upstream HTTP 400: bad field', { status: 502 }))).toBe(false);
    expect(isCredentialFailure(new GatewayError('upstream_error', 'Codex upstream HTTP 429: The usage limit has been reached', { status: 502 }))).toBe(false);
    expect(classifyFailure(new GatewayError('upstream_error', 'Upstream HTTP 400: bad field', { status: 502 }))).toBe('unknown');
  });

  it('still routes around a transient refresh failure, but does not retire the account', () => {
    // The production failure mode: a refresh that timed out (or met a 5xx, or a rolled-back write)
    // was recorded as `oauth_refresh_failed`, which the gateway reads as "the credentials are dead".
    // One flaky moment therefore disabled the account (`enabled=0`) — every live account read
    // `consecutive_failures = 0`, because no pattern was ever required before the verdict.
    const transient = () => new GatewayError('upstream_error', 'oauth_refresh_unavailable', { status: 502, cause: new Error('oauth_refresh_unavailable') });
    // Still a credential failure for routing: the request moves to a sibling account.
    expect(isCredentialFailure(transient())).toBe(true);
    expect(shouldRetryAttempt(null, transient())).toBe(true);
    expect(classifyFailure(transient())).toBe('credential');
    // But not a final verdict, so `markCredentialsDead` must not run for it.
    expect(isPermanentCredentialFailure(transient())).toBe(false);
  });

  it('treats a rejected grant as the final verdict that retires an account', () => {
    expect(isPermanentCredentialFailure(rawDeadCredential())).toBe(true);
    expect(isPermanentCredentialFailure(wrappedDeadCredential())).toBe(true);
  });

  it('advances to the next account with no combo plan configured', () => {
    // The reported bug: a direct `codex1/…` model has no combo, so the old code answered 502
    // instead of spending the retry on the next account of the same pool.
    expect(shouldRetryAttempt(null, rawDeadCredential())).toBe(true);
  });
});

describe('a dead credential disables the account and frees the pool', () => {
  it('writes the verdict and removes the account from the pool', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { closeDb, openDb, getRawDb } = await import('../../src/server/db');
    const { setConfigMasterKey } = await import('../../src/server/config');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-credential-disable-'));
    const savedKey = process.env.LATEDEV_MASTER_KEY;
    process.env.LATEDEV_MASTER_KEY = '12345678901234567890123456789012';
    setConfigMasterKey(process.env.LATEDEV_MASTER_KEY);
    openDb(path.join(dir, 'data.sqlite'));
    try {
      const raw = getRawDb();
      raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('cp','Codex','cp','codex','https://chatgpt.com')").run();

      const codexRepo = await import('../../src/server/db/repositories/codex-accounts');
      const { parseCodexImportText } = await import('../../src/server/providers/codex-import');
      const record = parseCodexImportText(JSON.stringify({
        access_token: 'access-token', refresh_token: 'refresh-token', email: 'dead@example.com',
        chatgpt_account_id: 'acct-dead', chatgpt_plan_type: 'plus',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }))[0] as never;
      const accountId = codexRepo.insertCodexAccount('cp', record);

      const candidate = (id: string) => ({ modelId: 'cm', publicModelId: 'codex1/gpt', providerId: 'cp', enabled: true, upstreamAvailable: true, circuitOpen: false, capabilities: {}, providerType: 'codex' as const, codexAccountId: id, codexChatgptAccountId: 'acct-dead' });
      // Healthy and offered by the pool before the verdict.
      expect(expandCodexAccountCandidates(candidate(accountId), codexRepo.listCodexAccountsForProvider('cp'))).toHaveLength(1);

      markCredentialsDead(candidate(accountId), 'oauth_refresh_failed');

      const row = raw.prepare('SELECT enabled, health_state AS h, last_error AS e FROM codex_accounts WHERE id=?').get(accountId) as { enabled: number; h: string; e: string | null };
      expect(row.enabled).toBe(0);
      expect(row.h).toBe('down');
      expect(row.e).toBe('oauth_refresh_failed');

      // The point of disabling: the next request must be offered a sibling account instead.
      expect(expandCodexAccountCandidates(candidate(accountId), codexRepo.listCodexAccountsForProvider('cp'))).toHaveLength(0);
      expect(codexRepo.getCodexAccountById(accountId)).toBeNull();
    } finally {
      closeDb();
      if (savedKey === undefined) delete process.env.LATEDEV_MASTER_KEY;
      else process.env.LATEDEV_MASTER_KEY = savedKey;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});