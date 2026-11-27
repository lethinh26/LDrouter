// Persistent daily, monthly and lifetime token quotas with single-process reservations.

import { and, eq, sql } from 'drizzle-orm';
import { getDb, getDatabaseEpoch, schema } from '../db/index';

export interface QuotaResult {
  allowed: boolean;
  reason?: 'daily' | 'monthly' | 'total';
}

interface QuotaLimits {
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  totalTokenLimit: number | null;
}

export interface QuotaReservation {
  resize(limits: QuotaLimits, tokens: number): QuotaResult;
  release(): void;
}

const pending = new Map<string, Map<symbol, number>>();

export function checkDailyMonthly(keyId: string, dailyLimit: number | null, monthlyLimit: number | null, tokens: number, totalLimit: number | null = null): QuotaResult {
  const db = getDb();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  if (dailyLimit != null && dailyLimit > 0) {
    const row = db.select({ t: schema.usageDaily.totalTokens }).from(schema.usageDaily).where(and(eq(schema.usageDaily.day, day), eq(schema.usageDaily.apiKeyId, keyId))).get();
    const used = row?.t ?? 0;
    if (used + tokens > dailyLimit) return { allowed: false, reason: 'daily' };
  }
  if (monthlyLimit != null && monthlyLimit > 0) {
    const row = db.select({ t: schema.usageMonthly.totalTokens }).from(schema.usageMonthly).where(and(eq(schema.usageMonthly.month, month), eq(schema.usageMonthly.apiKeyId, keyId))).get();
    const used = row?.t ?? 0;
    if (used + tokens > monthlyLimit) return { allowed: false, reason: 'monthly' };
  }
  if (totalLimit != null && totalLimit > 0) {
    const row = db.select({ t: sql<number>`coalesce(sum(${schema.usageMonthly.totalTokens}), 0)` }).from(schema.usageMonthly).where(eq(schema.usageMonthly.apiKeyId, keyId)).get();
    if ((row?.t ?? 0) + tokens > totalLimit) return { allowed: false, reason: 'total' };
  }
  return { allowed: true };
}

/** Reserve capacity synchronously before any upstream I/O. Pending requests
 * count against the current period until settled, including across midnight. */
export function reserveQuota(keyId: string, limits: QuotaLimits, tokens: number): { result: QuotaResult; reservation?: QuotaReservation } {
  const epochKey = `${getDatabaseEpoch()}:${keyId}`;
  const reservations = pending.get(epochKey) ?? new Map<symbol, number>();
  const id = Symbol();
  const resize = (nextLimits: QuotaLimits, nextTokens: number): QuotaResult => {
    let others = 0;
    for (const [otherId, amount] of reservations) if (otherId !== id) others += amount;
    const result = checkDailyMonthly(keyId, nextLimits.dailyTokenLimit, nextLimits.monthlyTokenLimit, nextTokens + others, nextLimits.totalTokenLimit);
    if (result.allowed) { reservations.set(id, nextTokens); pending.set(epochKey, reservations); }
    return result;
  };
  const result = resize(limits, tokens);
  if (!result.allowed) return { result };
  return { result, reservation: { resize, release() {
    reservations.delete(id);
    if (reservations.size === 0) pending.delete(epochKey);
  } } };
}

export function consumeUsage(keyId: string, inputTokens: number, outputTokens: number): void {
  const db = getDb();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const total = inputTokens + outputTokens;
  if (total === 0) return;
  db.transaction((tx) => {
  tx.insert(schema.usageDaily)
    .values({ day, apiKeyId: keyId, inputTokens, outputTokens, totalTokens: total })
    .onConflictDoUpdate({
      target: [schema.usageDaily.day, schema.usageDaily.apiKeyId],
      set: {
        inputTokens: sql`input_tokens + ${inputTokens}`,
        outputTokens: sql`output_tokens + ${outputTokens}`,
        totalTokens: sql`total_tokens + ${total}`,
      },
    })
    .run();
  tx.insert(schema.usageMonthly)
    .values({ month, apiKeyId: keyId, inputTokens, outputTokens, totalTokens: total })
    .onConflictDoUpdate({
      target: [schema.usageMonthly.month, schema.usageMonthly.apiKeyId],
      set: {
        inputTokens: sql`input_tokens + ${inputTokens}`,
        outputTokens: sql`output_tokens + ${outputTokens}`,
        totalTokens: sql`total_tokens + ${total}`,
      },
    })
    .run();
  });
}
