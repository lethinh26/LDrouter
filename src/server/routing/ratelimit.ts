// In-memory rate limiter: token bucket per key for RPM, TPM, concurrency.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const rpmBuckets = new Map<string, Bucket>();
const tpmBuckets = new Map<string, Bucket>();
const concurrentCounters = new Map<string, number>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: 'rpm' | 'tpm' | 'concurrent' | 'daily' | 'monthly';
}

export function checkRpm(keyId: string, rpmLimit: number | null): RateLimitResult {
  if (rpmLimit == null || rpmLimit <= 0) return { allowed: true };
  const now = Date.now();
  const bucket = rpmBuckets.get(keyId) ?? { tokens: rpmLimit, lastRefill: now };
  // Refill 1 token per (60_000 / rpm) ms
  const elapsed = now - bucket.lastRefill;
  const refillPerMs = rpmLimit / 60_000;
  const newTokens = Math.min(rpmLimit, bucket.tokens + elapsed * refillPerMs);
  if (newTokens < 1) {
    rpmBuckets.set(keyId, { tokens: newTokens, lastRefill: now });
    const wait = (1 - newTokens) / refillPerMs / 1000;
    return { allowed: false, reason: 'rpm', retryAfterSeconds: Math.ceil(wait) };
  }
  rpmBuckets.set(keyId, { tokens: newTokens - 1, lastRefill: now });
  return { allowed: true };
}

export function checkTpm(keyId: string, tpmLimit: number | null, tokensToConsume: number): RateLimitResult {
  if (tpmLimit == null || tpmLimit <= 0) return { allowed: true };
  const now = Date.now();
  const bucket = tpmBuckets.get(keyId) ?? { tokens: tpmLimit, lastRefill: now };
  const elapsed = now - bucket.lastRefill;
  const refillPerMs = tpmLimit / 60_000;
  const newTokens = Math.min(tpmLimit, bucket.tokens + elapsed * refillPerMs);
  if (newTokens < tokensToConsume) {
    tpmBuckets.set(keyId, { tokens: newTokens, lastRefill: now });
    const wait = (tokensToConsume - newTokens) / refillPerMs / 1000;
    return { allowed: false, reason: 'tpm', retryAfterSeconds: Math.ceil(wait) };
  }
  tpmBuckets.set(keyId, { tokens: newTokens - tokensToConsume, lastRefill: now });
  return { allowed: true };
}

export function acquireConcurrent(keyId: string, max: number | null): boolean {
  if (max == null || max <= 0) {
    concurrentCounters.set(keyId, (concurrentCounters.get(keyId) ?? 0) + 1);
    return true;
  }
  const cur = concurrentCounters.get(keyId) ?? 0;
  if (cur >= max) return false;
  concurrentCounters.set(keyId, cur + 1);
  return true;
}

export function releaseConcurrent(keyId: string): void {
  const cur = concurrentCounters.get(keyId) ?? 0;
  concurrentCounters.set(keyId, Math.max(0, cur - 1));
}

export function activeRequests(): number {
  let total = 0;
  for (const v of concurrentCounters.values()) total += v;
  return total;
}
