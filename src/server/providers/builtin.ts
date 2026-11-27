// Built-in identity is independent of names, compatible protocol and credentials.
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import type { Provider } from '../db/schema';
import { GatewayError } from '../errors';
import { CLAUDE_CODE_ORIGIN, CODEX_ORIGIN } from './integration';

export const BUILTIN_PROVIDERS = [
  { kind: 'codex', name: 'Codex', slug: 'cx', type: 'openai', authMode: 'client_oauth', origin: CODEX_ORIGIN },
  { kind: 'claude_code', name: 'Claude Code', slug: 'cc', type: 'anthropic', authMode: 'api_key', origin: CLAUDE_CODE_ORIGIN },
] as const;
export type BuiltinProvider = typeof BUILTIN_PROVIDERS[number];
type NamespaceDb = Pick<ReturnType<typeof getDb>, 'select'>;

export function isBuiltinSlugReserved(slug: string): boolean {
  return slug === 'cx' || slug === 'cc' || slug.startsWith('builtin-connection-');
}

export function connectionNamespaceMode(db: NamespaceDb, providerId: string): 'legacy' | 'canonical' | null {
  return db.select().from(schema.providerConnections).where(eq(schema.providerConnections.providerId, providerId)).get()?.namespaceMode ?? null;
}

export function providerPublicPrefix(db: NamespaceDb, provider: Provider): string {
  if (connectionNamespaceMode(db, provider.id) !== 'canonical') return provider.slug;
  const integration = db.select().from(schema.providerIntegrations).where(eq(schema.providerIntegrations.providerId, provider.id)).get();
  const builtin = BUILTIN_PROVIDERS.find(b => b.kind === integration?.providerKind);
  if (!builtin || provider.slug !== 'builtin-connection-' + provider.id) throw new GatewayError('gateway_error', 'Invalid built-in provider identity', { status: 500 });
  return builtin.slug;
}

/** Existing custom/legacy prefixes stay owned by the existing routes. Never
 * silently rename or adopt them, even if a provider has a similar name. */
export function builtinNamespaceConflicts(db: NamespaceDb, builtin: BuiltinProvider): string[] {
  const canonical = new Set(db.select({ id: schema.providerConnections.providerId, mode: schema.providerConnections.namespaceMode, kind: schema.providerIntegrations.providerKind })
    .from(schema.providerConnections).innerJoin(schema.providerIntegrations, eq(schema.providerIntegrations.providerId, schema.providerConnections.providerId)).all()
    .filter(c => c.mode === 'canonical' && c.kind === builtin.kind).map(c => c.id));
  const prefix = builtin.slug + '/';
  const conflicts = new Set<string>();
  for (const p of db.select({ id: schema.providers.id, slug: schema.providers.slug }).from(schema.providers).all()) {
    if (p.slug.toLowerCase() === builtin.slug) conflicts.add('Provider: ' + p.slug);
  }
  for (const m of db.select({ id: schema.models.publicModelId, providerId: schema.models.providerId }).from(schema.models).all()) {
    if (m.id.toLowerCase().startsWith(prefix) && !canonical.has(m.providerId)) conflicts.add('Model: ' + m.id);
  }
  for (const a of db.select({ name: schema.modelAliases.alias }).from(schema.modelAliases).all()) {
    if (a.name.toLowerCase().startsWith(prefix)) conflicts.add('Alias: ' + a.name);
  }
  for (const c of db.select({ name: schema.combos.publicModelId }).from(schema.combos).all()) {
    if (c.name.toLowerCase().startsWith(prefix)) conflicts.add('Combo: ' + c.name);
  }
  return [...conflicts].sort();
}

export function assertBuiltinNamespaceAvailable(db: NamespaceDb, builtin: BuiltinProvider): void {
  if (builtinNamespaceConflicts(db, builtin).length > 0) throw new GatewayError('invalid_request_error', 'Built-in namespace is occupied by existing routing configuration; resolve the reported conflicts first', { status: 409, code: 'builtin_namespace_conflict' });
}
