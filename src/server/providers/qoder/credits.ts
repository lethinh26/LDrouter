// Qoder Credits: the account's real usage. Qoder bills in Credits, not tokens — its chat
// stream carries no usage block at all — so the quota API is the only upstream truth about
// consumption. `is_free` on a catalog entry is the separate signal that a model is covered
// by a promotion (e.g. Qwen3.8-Max) and therefore does not draw on Credits at all.
import { QODER_CREDITS_URL } from './constants';

const FETCH_TIMEOUT_MS = 10_000;

export interface QoderCreditsBucket {
  label: string;
  total: number;
  used: number;
  remaining: number;
  unit: string;
}

export interface QoderCredits {
  /** Plan name from the upstream, e.g. `personal_standard`. */
  userType: string;
  /** Model keys whose live catalog entry is marked `is_free` — promotions, no Credits spent. */
  freeModels: string[];
  buckets: QoderCreditsBucket[];
  totalUsedPercent: number;
  exhausted: boolean;
  expiresAt: string | null;
  upgradeUrl: string | null;
  fetchedAt: string;
  unavailable?: string;
}

interface RawBucket {
  total?: unknown;
  used?: unknown;
  remaining?: unknown;
  unit?: unknown;
}

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function isoOrNull(value: unknown): string | null {
  const ms = typeof value === 'number' ? value : Number(value);
  // 253402214400000 is the far-future sentinel Qoder sends for "no expiry".
  if (!Number.isFinite(ms) || ms >= 253402214400000) return null;
  return new Date(ms).toISOString();
}

function bucket(label: string, raw: unknown): QoderCreditsBucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as RawBucket;
  const total = numberOr(value.total, 0);
  if (total <= 0) return null;
  const used = numberOr(value.used, 0);
  return {
    label,
    total,
    used,
    remaining: numberOr(value.remaining, Math.max(0, total - used)),
    unit: typeof value.unit === 'string' && value.unit ? value.unit : 'credits',
  };
}

export function parseQoderCredits(body: unknown, freeModels: string[], fetchedAt: string): QoderCredits {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const buckets = [bucket('Plan credits', raw.userQuota), bucket('Add-on credits', raw.addOnQuota), bucket('Org resource package', raw.orgResourcePackage)].filter(
    (entry): entry is QoderCreditsBucket => entry !== null,
  );
  return {
    userType: typeof raw.userType === 'string' ? raw.userType : 'unknown',
    freeModels,
    buckets,
    totalUsedPercent: numberOr(raw.totalUsagePercentage, 0),
    exhausted: raw.isQuotaExceeded === true,
    expiresAt: isoOrNull(raw.expiresAt),
    upgradeUrl: typeof raw.upgradeUrl === 'string' && raw.upgradeUrl ? raw.upgradeUrl : null,
    fetchedAt,
  };
}

/**
 * Live Credits snapshot. A failure is reported as `unavailable` rather than thrown: Credits are
 * observability, and an account that cannot report them must keep serving requests.
 */
export async function fetchQoderCredits(
  creds: { jobToken: string },
  freeModels: string[],
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<QoderCredits> {
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(QODER_CREDITS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${creds.jobToken}`, accept: 'application/json', 'user-agent': 'qodercli/1.0.0' },
      signal: controller.signal,
    });
    if (!response.ok) return { ...parseQoderCredits({}, freeModels, fetchedAt), unavailable: `HTTP ${response.status}` };
    return parseQoderCredits(await response.json(), freeModels, fetchedAt);
  } catch (error) {
    return { ...parseQoderCredits({}, freeModels, fetchedAt), unavailable: error instanceof Error ? error.message : 'Credits request failed' };
  } finally {
    clearTimeout(timer);
  }
}
