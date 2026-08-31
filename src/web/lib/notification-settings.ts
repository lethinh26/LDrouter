// Shared reactive store for notification preferences (cards + sound).
// Both the Settings page and the request-notifications hook read the same live
// prefs via useSyncExternalStore, so a toggle in Settings applies instantly.
import { useSyncExternalStore } from 'react';
import { api } from './api';

interface Prefs { enabled: boolean; sound: boolean }

const DEFAULTS: Prefs = { enabled: true, sound: true };

let state: Prefs = DEFAULTS;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** GET /api/admin/settings once; idempotent. `force` re-fetches. */
export function loadNotificationPrefs(force = false): Promise<void> {
  if (loaded && !force) return Promise.resolve();
  if (!force && loading) return loading;
  loading = (async () => {
    try {
      const r = await api.get<{ settings: { notificationsEnabled?: boolean; notificationSoundEnabled?: boolean } }>('/api/admin/settings');
      state = {
        enabled: r.settings.notificationsEnabled ?? DEFAULTS.enabled,
        sound: r.settings.notificationSoundEnabled ?? DEFAULTS.sound,
      };
      loaded = true;
      notify();
    } catch { /* keep defaults on failure — never break notifications */ }
  })();
  return loading;
}

/** PATCH a partial pref, then update local state so subscribers re-render. */
export async function saveNotificationPrefs(patch: Partial<Prefs>): Promise<void> {
  const body: { notificationsEnabled?: boolean; notificationSoundEnabled?: boolean } = {};
  if (patch.enabled !== undefined) body.notificationsEnabled = patch.enabled;
  if (patch.sound !== undefined) body.notificationSoundEnabled = patch.sound;
  await api.patch('/api/admin/settings', body);
  state = { ...state, ...patch };
  loaded = true;
  notify();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useNotificationPrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
