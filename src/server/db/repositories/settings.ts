// Repository: application settings (singleton row in app_settings table).

import { getDb, schema } from '../index';
import { eq } from 'drizzle-orm';
import type { AppSettings, ContentLogMode } from '../../../shared/types';

function rowToSettings(row: typeof schema.appSettings.$inferSelect): AppSettings {
  return {
    setupComplete: row.setupComplete,
    retentionDays: row.retentionDays,
    retentionMode: 'custom',
    customRetentionDays: row.retentionDays,
    contentLogMode: row.contentLogMode as ContentLogMode,
    dbSizeLimitMb: row.dbSizeLimitMb,
    trustProxyHops: row.trustProxyHops,
    schemaVersion: row.schemaVersion,
    appVersion: row.appVersion,
    gatewayCacheEnabled: row.gatewayCacheEnabled,
    gatewayCacheDefaultTtlSeconds: row.gatewayCacheDefaultTtlSeconds,
    gatewayCacheMaxSizeMb: row.gatewayCacheMaxSizeMb,
    masterKeyConfigured: row.masterKeyConfigured,
    masterKeyVersion: row.masterKeyVersion,
    notificationsEnabled: row.notificationsEnabled,
    notificationSoundEnabled: row.notificationSoundEnabled,
  };
}

export function getSettings(): AppSettings {
  const db = getDb();
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.id, 1)).get();
  if (!row) {
    // Bootstrap if somehow missing.
    db.insert(schema.appSettings).values({ id: 1 }).run();
    const again = db.select().from(schema.appSettings).where(eq(schema.appSettings.id, 1)).get();
    if (!again) throw new Error('app_settings bootstrap failed');
    return rowToSettings(again);
  }
  return rowToSettings(row);
}

export function updateSettings(patch: Partial<Omit<AppSettings, 'schemaVersion' | 'appVersion' | 'masterKeyVersion'>>): AppSettings {
  const db = getDb();
  const update: Partial<typeof schema.appSettings.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.setupComplete !== undefined) update.setupComplete = patch.setupComplete;
  if (patch.retentionDays !== undefined) update.retentionDays = patch.retentionDays;
  if (patch.contentLogMode !== undefined) update.contentLogMode = patch.contentLogMode;
  if (patch.dbSizeLimitMb !== undefined) update.dbSizeLimitMb = patch.dbSizeLimitMb;
  if (patch.trustProxyHops !== undefined) update.trustProxyHops = patch.trustProxyHops;
  if (patch.gatewayCacheEnabled !== undefined) update.gatewayCacheEnabled = patch.gatewayCacheEnabled;
  if (patch.gatewayCacheDefaultTtlSeconds !== undefined) update.gatewayCacheDefaultTtlSeconds = patch.gatewayCacheDefaultTtlSeconds;
  if (patch.gatewayCacheMaxSizeMb !== undefined) update.gatewayCacheMaxSizeMb = patch.gatewayCacheMaxSizeMb;
  if (patch.masterKeyConfigured !== undefined) update.masterKeyConfigured = patch.masterKeyConfigured;
  if (patch.notificationsEnabled !== undefined) update.notificationsEnabled = patch.notificationsEnabled;
  if (patch.notificationSoundEnabled !== undefined) update.notificationSoundEnabled = patch.notificationSoundEnabled;
  db.update(schema.appSettings).set(update).where(eq(schema.appSettings.id, 1)).run();
  return getSettings();
}

export function markSetupComplete(): void {
  updateSettings({ setupComplete: true });
}
