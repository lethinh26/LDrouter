// Repository: audit logs.

import { getDb, schema } from '../index';
import { and, desc, eq, gte, like, lte, sql } from 'drizzle-orm';
import { uuid } from '../../auth/ids';
import { redactValue } from '../../security/redact';
import type { AuditLogEntry } from '../../../shared/types';

export interface AuditInput {
  action: string;
  actor?: string;
  ip?: string;
  success: boolean;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  metadata?: Record<string, unknown>;
}

export function recordAudit(input: AuditInput): void {
  const db = getDb();
  const safeMetadata = input.metadata ? redactValue(input.metadata) : null;
  db.insert(schema.auditLogs)
    .values({
      id: uuid(),
      action: input.action,
      actor: input.actor ?? 'admin',
      ip: input.ip ?? null,
      success: input.success,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      targetName: input.targetName ?? null,
      metadataJson: safeMetadata ? JSON.stringify(safeMetadata) : null,
    })
    .run();
}

export interface AuditQuery {
  from?: string;
  to?: string;
  action?: string;
  success?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export function queryAudit(q: AuditQuery = {}): { rows: AuditLogEntry[]; total: number } {
  const db = getDb();
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);

  const conds = [];
  if (q.from) conds.push(gte(schema.auditLogs.createdAt, q.from));
  if (q.to) conds.push(lte(schema.auditLogs.createdAt, q.to));
  if (q.action) conds.push(eq(schema.auditLogs.action, q.action));
  if (q.success !== undefined) conds.push(eq(schema.auditLogs.success, q.success));
  if (q.search) conds.push(like(schema.auditLogs.targetName, `%${q.search}%`));
  const whereExpr = conds.length ? and(...conds) : undefined;

  const rows = db
    .select()
    .from(schema.auditLogs)
    .where(whereExpr)
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const totalRow = db
    .select({ c: sql<number>`COUNT(*)` })
    .from(schema.auditLogs)
    .where(whereExpr)
    .get();

  return {
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      actor: r.actor,
      ip: r.ip ?? '',
      success: Boolean(r.success),
      targetType: r.targetType,
      targetId: r.targetId,
      targetName: r.targetName,
      metadata: r.metadataJson ? safeJsonParse(r.metadataJson) : {},
    })),
    total: totalRow?.c ?? 0,
  };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
