// Daily / monthly token quota enforcement using usage_daily/usage_monthly tables.

import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index';

export interface QuotaResult {
  allowed: boolean;
  reason?: 'daily' | 'monthly';
}

export function checkDailyMonthly(keyId: string, dailyLimit: number | null, monthlyLimit: number | null, tokens: number): QuotaResult {
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
  return { allowed: true };
}

export function consumeUsage(keyId: string, inputTokens: number, outputTokens: number): void {
  const db = getDb();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const total = inputTokens + outputTokens;
  db.insert(schema.usageDaily)
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
  db.insert(schema.usageMonthly)
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
}
