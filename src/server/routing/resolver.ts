// Model resolution: physical model, combo, or alias (one hop only).

import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { GatewayError } from '../errors';

export type ResolvedTarget =
  | { kind: 'model'; modelId: string; publicModelId: string }
  | { kind: 'combo'; comboId: string; publicModelId: string }
  | { kind: 'alias'; aliasId: string; alias: string; resolved: ResolvedTarget };

export function resolveRequestedModel(requested: string): ResolvedTarget {
  const db = getDb();
  // Physical model
  const model = db.select().from(schema.models).where(eq(schema.models.publicModelId, requested)).get();
  if (model && model.enabled) {
    return { kind: 'model', modelId: model.id, publicModelId: model.publicModelId };
  }
  // Combo by exact public ID — with-prefix ("combo/<slug>") or the
  // prefix-less default (<slug>).
  const combo = db.select().from(schema.combos).where(eq(schema.combos.publicModelId, requested)).get();
  if (combo && combo.enabled) return { kind: 'combo', comboId: combo.id, publicModelId: combo.publicModelId };
  // Alias (one hop only)
  const alias = db.select().from(schema.modelAliases).where(and(eq(schema.modelAliases.alias, requested), eq(schema.modelAliases.enabled, true))).get();
  if (alias) {
    if (alias.targetKind === 'model') {
      const m = db.select().from(schema.models).where(eq(schema.models.id, alias.targetId)).get();
      if (m && m.enabled) return { kind: 'alias', aliasId: alias.id, alias: alias.alias, resolved: { kind: 'model', modelId: m.id, publicModelId: m.publicModelId } };
    } else {
      const c = db.select().from(schema.combos).where(eq(schema.combos.id, alias.targetId)).get();
      if (c && c.enabled) return { kind: 'alias', aliasId: alias.id, alias: alias.alias, resolved: { kind: 'combo', comboId: c.id, publicModelId: c.publicModelId } };
    }
  }
  // Maybe the user typed the combo slug without the prefix
  if (!requested.includes('/')) {
    const c = db.select().from(schema.combos).where(eq(schema.combos.slug, requested)).get();
    if (c && c.enabled) return { kind: 'combo', comboId: c.id, publicModelId: c.publicModelId };
  }
  throw new GatewayError('model_not_found', `Unknown model: ${requested}`, { status: 404 });
}

export function unwrapAlias(t: ResolvedTarget): Exclude<ResolvedTarget, { kind: 'alias' }> {
  if (t.kind === 'alias') return t.resolved as Exclude<ResolvedTarget, { kind: 'alias' }>;
  return t as Exclude<ResolvedTarget, { kind: 'alias' }>;
}
