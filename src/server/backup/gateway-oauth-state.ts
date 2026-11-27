import type Database from 'better-sqlite3';

// These first-party authentication sessions are volatile across a restore.
// A backup must not resurrect an old access token or rotated refresh token.
export const GATEWAY_OAUTH_VOLATILE_TABLES = [
  'gateway_oauth_used_refresh', 'gateway_oauth_codes', 'gateway_oauth_grants',
] as const;

/** Operate on private staging/snapshot files, never the serving database. */
export function removeGatewayOAuthState(db: Database.Database): void {
  db.pragma('secure_delete = ON');
  db.transaction(() => {
    for (const table of GATEWAY_OAUTH_VOLATILE_TABLES) db.prepare(`DELETE FROM "${table}"`).run();
  }).immediate();
}
