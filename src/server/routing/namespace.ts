// Shared namespace checks for the exact names accepted by the gateway resolver.
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { GatewayError } from '../errors';

type NamespaceDb = Pick<ReturnType<typeof getDb>, 'select'>;

export function normalizeProviderSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  if (!slug) throw new GatewayError('invalid_request_error', 'Provider slug must contain a letter or number', { status: 400, code: 'invalid_provider_slug' });
  return slug;
}

function providerSlugTaken(db: NamespaceDb, slug: string, excludeId?: string): boolean {
  if (slug === 'combo') return true;
  const owner = db.select({ id: schema.providers.id }).from(schema.providers).where(eq(schema.providers.slug, slug)).get();
  if (owner && owner.id !== excludeId) return true;
  // Older versions allowed renaming a provider without renaming its existing
  // model IDs. Reserve those prefixes too, even when no provider owns the slug.
  return db.select({ id: schema.models.id }).from(schema.models).where(sql`substr(${schema.models.publicModelId}, 1, ${slug.length + 1}) = ${slug + '/'} AND ${schema.models.providerId} != ${excludeId ?? ''}`).get() !== undefined;
}

export function assertProviderSlugFree(db: NamespaceDb, slug: string, excludeId?: string): void {
  if (!providerSlugTaken(db, slug, excludeId)) return;
  const base = slug === 'combo' ? 'provider' : slug;
  let suggested = `${base.slice(0, 58).replace(/-+$/, '')}-oauth`;
  for (let n = 2; providerSlugTaken(db, suggested, excludeId); n++) {
    const suffix = `-${n}`;
    suggested = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  throw new GatewayError('invalid_request_error', `Provider slug '${slug}' is reserved or already in use. Try '${suggested}'.`, { status: 409, code: 'provider_slug_conflict' });
}

/** A combo's bare slug also resolves, even if its public ID is prefixed. */
export function assertRoutingNameFree(db: NamespaceDb, name: string, ownerKind: 'model' | 'combo' | 'alias', excludeId?: string): void {
  const model = db.select({ id: schema.models.id }).from(schema.models).where(eq(schema.models.publicModelId, name)).get();
  const combo = db.select({ id: schema.combos.id }).from(schema.combos).where(sql`${schema.combos.publicModelId} = ${name} OR ${schema.combos.slug} = ${name}`).all();
  const alias = db.select({ id: schema.modelAliases.id }).from(schema.modelAliases).where(eq(schema.modelAliases.alias, name)).get();
  if ((model && !(ownerKind === 'model' && model.id === excludeId)) ||
      combo.some(c => !(ownerKind === 'combo' && c.id === excludeId)) ||
      (alias && !(ownerKind === 'alias' && alias.id === excludeId))) {
    const message = ownerKind === 'alias' && (model || combo.length > 0)
      ? `Alias '${name}' shadows an existing model or combo ID`
      : `Routing name '${name}' is already in use by a model, combo or alias`;
    throw new GatewayError('invalid_request_error', message, { status: 400, code: 'routing_name_conflict' });
  }
}
