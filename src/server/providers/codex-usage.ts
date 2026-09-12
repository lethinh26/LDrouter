// Codex account quota: usage snapshot (wham/usage), weekly reset credits, and the
// 5-hour window auto-start ("auto ping") request. Contracts mirror 9router.
import { codexRequest, codexHeaders, type CodexProviderConfig } from './codex';

export interface CodexQuota {
  used: number;
  total: number;
  remaining: number;
  resetAt: string | null;
}

export interface CodexUsage {
  plan: string;
  limitReached: boolean;
  resetCredits: number;
  quotas: Record<string, CodexQuota>;
  fetchedAt: string;
  unavailable?: string;
}

export interface CodexResetCredit {
  status: string;
  grantedAt: string | null;
  expiresAt: string | null;
}

export interface ConsumeResetResult {
  ok: boolean;
  noCredit: boolean;
  code: string | null;
  windowsReset: number;
  message: string | null;
}

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const RESET_CREDITS_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;
const UA = 'codex_cli_rs/0.136.0';

/** Auto-start ping: only starts a 5-hour window once the streaming body is fully drained. */
export const CODEX_PING = { model: 'gpt-5.5', text: 'hi', instructions: 'Reply with OK.' } as const;
/** codex_autostart_enabled accounts are never pinged more often than this. */
export const CODEX_AUTOSTART_MIN_INTERVAL_MS = 10 * 60 * 1000;

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : (value as string | number));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Codex nests the 5h/weekly windows under several upstream key spellings. */
function limitContainer(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.rate_limit && typeof record.rate_limit === 'object' ? (record.rate_limit as Record<string, unknown>) : record;
}

function innerWindow(container: Record<string, unknown> | null, ...keys: string[]): Record<string, unknown> | null {
  if (!container) return null;
  for (const key of keys) {
    const inner = container[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  return null;
}

function toQuota(window: Record<string, unknown>): CodexQuota {
  const used = Math.max(0, Math.min(100, numberOr(window.used_percent ?? window.percent_used, 0)));
  return { used, total: 100, remaining: Math.max(0, 100 - used), resetAt: isoOrNull(window.reset_at ?? window.resets_at ?? window.resetAt) };
}

export function readCodexQuotas(body: unknown): Record<string, CodexQuota> {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const limitIds = root.rate_limits_by_limit_id as Record<string, unknown> | undefined;
  const container = limitContainer(root.rate_limit ?? root.rate_limits ?? limitIds?.codex);
  if (!container) return {};
  const quotas: Record<string, CodexQuota> = {};
  // Primary window is the 5-hour quota; secondary is the weekly one. Bare objects are treated as primary.
  const primary = innerWindow(container, 'primary_window', 'primary')
    ?? ('used_percent' in container || 'percent_used' in container || 'reset_at' in container || 'resets_at' in container ? container : null);
  if (primary) quotas.session = toQuota(primary);
  const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];
  const secondary = innerWindow(container, 'secondary_window', 'secondary')
    ?? innerWindow(limitContainer(additional.find((entry) => {
      const name = String((entry as Record<string, unknown>)?.limit_name ?? (entry as Record<string, unknown>)?.metered_feature ?? (entry as Record<string, unknown>)?.id ?? '').toLowerCase();
      return !name.includes('session');
    })), 'primary_window', 'primary');
  if (secondary) quotas.blocking = toQuota(secondary);
  return quotas;
}

export function parseCodexUsage(body: unknown, now = new Date()): CodexUsage {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    plan: typeof root.plan_type === 'string' ? root.plan_type : 'unknown',
    limitReached: limitContainer(root.rate_limit)?.limit_reached === true,
    resetCredits: Math.max(0, numberOr((root.rate_limit_reset_credits as Record<string, unknown> | undefined)?.available_count, 0)),
    quotas: readCodexQuotas(root),
    fetchedAt: now.toISOString(),
  };
}

function timeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function credentialHeaders(accessToken: string, accountId?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'openai-beta': 'codex-1',
    originator: 'codex_cli_rs',
    'user-agent': UA,
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    ...extra,
  };
}

/** Reads the 5h/blocking windows for one account. Throws on transport/auth failure. */
export async function fetchCodexUsage(accessToken: string, accountId?: string, timeoutMs = 15_000): Promise<CodexUsage> {
  const ctl = timeout(timeoutMs);
  try {
    const response = await fetch(USAGE_URL, { headers: credentialHeaders(accessToken, accountId), signal: ctl.signal });
    if (!response.ok) throw Object.assign(new Error(`Codex usage API returned HTTP ${response.status}`), { status: response.status });
    return parseCodexUsage(await response.json());
  } finally { ctl.cancel(); }
}

export async function fetchCodexResetCredits(accessToken: string, accountId?: string, timeoutMs = 15_000): Promise<{ availableCount: number; credits: CodexResetCredit[] }> {
  const ctl = timeout(timeoutMs);
  try {
    const response = await fetch(RESET_CREDITS_URL, { headers: credentialHeaders(accessToken, accountId), signal: ctl.signal });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw Object.assign(new Error('Codex reset credits API unavailable'), { status: response.status });
    return {
      availableCount: Math.max(0, numberOr(body?.available_count ?? body?.availableCount, 0)),
      credits: (Array.isArray(body?.credits) ? body!.credits : []).map((credit) => {
        const entry = credit as Record<string, unknown>;
        return { status: String(entry?.status ?? 'unknown'), grantedAt: isoOrNull(entry?.granted_at ?? entry?.grantedAt), expiresAt: isoOrNull(entry?.expires_at ?? entry?.expiresAt) };
      }),
    };
  } finally { ctl.cancel(); }
}

/** Spends one weekly reset credit to restart the 5h window immediately. */
export async function consumeCodexResetCredit(accessToken: string, accountId?: string, timeoutMs = 20_000): Promise<ConsumeResetResult> {
  const ctl = timeout(timeoutMs);
  try {
    const response = await fetch(RESET_CREDITS_CONSUME_URL, {
      method: 'POST',
      headers: credentialHeaders(accessToken, accountId, { 'content-type': 'application/json' }),
      body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
      signal: ctl.signal,
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const code = typeof body?.code === 'string' ? body.code : null;
    const windowsReset = numberOr(body?.windows_reset, 0);
    if (!response.ok) throw Object.assign(new Error(response.status === 409 ? 'No Codex reset credits available' : `Codex reset credit failed (HTTP ${response.status})`), { status: response.status });
    return { ok: code === 'reset' || windowsReset > 0, noCredit: code === 'no_credit', code, windowsReset, message: typeof body?.message === 'string' ? body.message : null };
  } finally { ctl.cancel(); }
}

/**
 * Sends the tiny streaming request that opens the next 5-hour window.
 * Codex only starts the window after the stream completes, so the body is drained.
 */
export async function pingCodexAccount(cfg: CodexProviderConfig, model = CODEX_PING.model): Promise<boolean> {
  const ctl = timeout(cfg.totalTimeoutMs);
  try {
    const response = await fetch(codexRequest(cfg, '/responses'), {
      method: 'POST',
      headers: codexHeaders(cfg, 'text/event-stream'),
      body: JSON.stringify({
        model,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: CODEX_PING.text }] }],
        instructions: CODEX_PING.instructions,
        reasoning: { effort: 'none', summary: 'auto' },
        store: false,
        stream: true,
      }),
      signal: ctl.signal,
    });
    if (!response.ok) { await response.body?.cancel?.().catch(() => undefined); return false; }
    const reader = response.body?.getReader();
    if (!reader) return true;
    try { for (;;) { const { done } = await reader.read(); if (done) break; } } finally { reader.releaseLock(); }
    return true;
  } finally { ctl.cancel(); }
}
