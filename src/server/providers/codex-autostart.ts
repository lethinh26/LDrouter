// Codex 5-hour window auto-start: pings opted-in accounts the moment their window resets
// so a fresh 5h window opens immediately. Mirrors 9router's quota auto-ping (codex profile).
//
// Ruling: no separate in-memory reset cache. `last_pinged_reset_key` already guarantees one ping
// per reset minute, and that survives restarts. A cache would add a second, weaker source of truth.

import { getRawDb } from '../db/index';
import { listCodexAutostartTargets, markCodexAccountPinged, saveCodexUsage, saveCodexUsageError } from '../db/repositories/codex-accounts';
import { withCodexCredentials } from './codex-refresh';
import { CODEX_AUTOSTART_MIN_INTERVAL_MS, fetchCodexUsage, pingCodexAccount, type CodexUsage } from './codex-usage';

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

interface ProviderRow { id: string; base_url: string; total_timeout_ms: number }
interface AccountRow { id: string; chatgpt_account_id: string | null }

function providerFor(providerId: string): ProviderRow | null {
  return (getRawDb().prepare('SELECT id,base_url,total_timeout_ms FROM providers WHERE id=? AND enabled=1').get(providerId) as ProviderRow | undefined) ?? null;
}

function accountFor(accountId: string): AccountRow | null {
  return (getRawDb().prepare('SELECT id,chatgpt_account_id FROM codex_accounts WHERE id=?').get(accountId) as AccountRow | undefined) ?? null;
}

/**
 * Keep the quota snapshot honest while the account is in use.
 *
 * The usage API is a second upstream call, so this is throttled rather than run per request: a
 * snapshot younger than the interval is left alone. Before this, usage only refreshed when an admin
 * pressed the button or on the 10-minute autostart tick for opted-in accounts, so a dashboard could
 * show hours-old consumption for an account actively serving traffic.
 */
export const CODEX_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export async function refreshCodexUsageIfStale(accountId: string, now = new Date()): Promise<void> {
  const row = getRawDb().prepare('SELECT provider_id AS providerId,chatgpt_account_id AS chatgptAccountId,codex_usage_updated_at AS at FROM codex_accounts WHERE id=?').get(accountId) as { providerId: string; chatgptAccountId: string | null; at: string | null } | undefined;
  if (!row) return;
  const provider = providerFor(row.providerId);
  if (!provider) return;
  const last = row.at ? Date.parse(row.at) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < CODEX_USAGE_REFRESH_INTERVAL_MS) return;
  await refreshStoredCodexUsage(accountId, provider, { id: accountId, chatgpt_account_id: row.chatgptAccountId });
}

/** Reads fresh usage; stores the snapshot or a sanitized reason on failure. */
export async function refreshStoredCodexUsage(accountId: string, provider: ProviderRow, account: AccountRow): Promise<CodexUsage | null> {
  try {
    const usage = await withCodexCredentials(accountId, (credentials) => fetchCodexUsage(credentials.accessToken, account.chatgpt_account_id ?? undefined, Math.min(provider.total_timeout_ms, 20_000)));
    saveCodexUsage(accountId, usage);
    return usage;
  } catch (error) {
    saveCodexUsageError(accountId, error instanceof Error ? error.message : 'Codex usage unavailable');
    return null;
  }
}

/** Minute-precision reset key: guards against duplicate pings from clock drift. */
function resetKey(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) ? new Date(Math.floor(ms / 60_000) * 60_000).toISOString() : resetAt;
}

/** One account: refresh usage, then ping if the window is exhausted and its reset already passed. */
export async function runCodexAutostartForAccount(accountId: string, now = new Date()): Promise<'pinged' | 'skipped' | 'failed'> {
  const target = listCodexAutostartTargets().find((row) => row.id === accountId);
  if (!target) return 'skipped';
  if (target.lastPingAt && now.getTime() - Date.parse(target.lastPingAt) < CODEX_AUTOSTART_MIN_INTERVAL_MS) return 'skipped';
  const provider = providerFor(target.providerId);
  const account = accountFor(accountId);
  if (!provider || !account) return 'skipped';
  const usage = await refreshStoredCodexUsage(accountId, provider, account);
  if (!usage) return 'failed';
  const session = usage.quotas.session;
  const key = resetKey(session?.resetAt ?? null);
  const row = getRawDb().prepare('SELECT last_pinged_reset_key AS k FROM codex_accounts WHERE id=?').get(accountId) as { k: string | null } | undefined;
  if (row?.k && key && row.k === key) return 'skipped';
  // A blocking (weekly) window that is exhausted means a ping cannot open anything.
  if (usage.quotas.blocking && usage.quotas.blocking.remaining <= 0) return 'skipped';
  if (session && session.remaining > 0) return 'skipped';
  const ok = await withCodexCredentials(accountId, (credentials) => pingCodexAccount({
    baseUrl: provider.base_url, accountId: account.chatgpt_account_id ?? '', accessToken: credentials.accessToken,
    accountRecordId: accountId, customHeaders: {}, totalTimeoutMs: Math.min(provider.total_timeout_ms, 120_000),
  }));
  if (!ok) return 'failed';
  markCodexAccountPinged(accountId, session?.resetAt ?? null, key);
  return 'pinged';
}

export async function runCodexAutostartTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const target of listCodexAutostartTargets()) {
      try { await runCodexAutostartForAccount(target.id); } catch { /* per-account isolation */ }
    }
  } finally { running = false; }
}

export function startCodexAutostart(): void {
  if (timer) return;
  timer = setInterval(() => { void runCodexAutostartTick(); }, TICK_MS);
  timer.unref?.();
}

export function stopCodexAutostart(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
