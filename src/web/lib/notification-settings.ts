// Shared reactive store for notification preferences (cards + sound).
// Both the Settings page and the request-notifications hook read the same live
// prefs via useSyncExternalStore, so a toggle in Settings applies instantly.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { disposeRequestAudio } from './sound-feedback';

interface Prefs { enabled: boolean; sound: boolean }

const DEFAULTS: Prefs = { enabled: true, sound: true };

let state: Prefs = DEFAULTS;
let loaded = false;
let loading: Promise<boolean> | null = null;
let mutationVersion = 0;
let loadVersion = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** GET /api/admin/settings once; idempotent. Returns false until persisted prefs load successfully. */
export function loadNotificationPrefs(force = false): Promise<boolean> {
  if (loaded && !force) return Promise.resolve(true);
  if (!force && loading) return loading;
  const versionAtStart = mutationVersion;
  const requestVersion = ++loadVersion;
  const request = (async () => {
    try {
      const r = await api.get<{ settings: { notificationsEnabled?: boolean; notificationSoundEnabled?: boolean } }>('/api/admin/settings');
      if (versionAtStart === mutationVersion && requestVersion === loadVersion) {
        state = {
          enabled: r.settings.notificationsEnabled ?? DEFAULTS.enabled,
          sound: r.settings.notificationSoundEnabled ?? DEFAULTS.sound,
        };
        loaded = true;
        notify();
      }
    } catch {
      // Fail closed: callers must not start SSE/audio until the persisted
      // preferences have loaded. The shell retries this operation while mounted.
    }
    return loaded;
  })();
  loading = request;
  // Run cleanup after the promise has been assigned to `loading`, and only
  // clear it if no newer forced refresh has replaced this in-flight request.
  void request.then(() => { if (loading === request) loading = null; });
  return request;
}

/** Optimistically publish a partial preference, then reconcile it with PATCH. */
export async function saveNotificationPrefs(patch: Partial<Prefs>): Promise<void> {
  // Never merge a partial write into defaults while the initial GET is still
  // pending: the untouched preference may already be opted out in SQLite.
  if (!loaded && !await loadNotificationPrefs()) {
    throw new Error('Could not load saved notification preferences. Try again.');
  }

  const body: { notificationsEnabled?: boolean; notificationSoundEnabled?: boolean } = {};
  if (patch.enabled !== undefined) body.notificationsEnabled = patch.enabled;
  if (patch.sound !== undefined) body.notificationSoundEnabled = patch.sound;

  // Publish the user's explicit choice immediately. In particular, enabling
  // sound already unlocked AudioContext in the same gesture; a request event
  // arriving while PATCH is in flight must not be consumed with the old `false`
  // preference and silently lost.
  const previousState = state;
  mutationVersion += 1;
  const currentMutation = mutationVersion;
  loadVersion += 1;
  state = { ...state, ...patch };
  loaded = true;
  notify();
  try {
    await api.patch('/api/admin/settings', body);
    // Keep an already-unlocked context alive while an optimistic disable is
    // pending. Dispose only after the server confirms the latest disable.
    if (mutationVersion === currentMutation && patch.sound === false && state.sound === false) {
      disposeRequestAudio();
    }
  } catch (error) {
    // Do not roll back over a newer user mutation if one was started while this
    // request was pending. The Settings card serializes edits, but the guard
    // also keeps this store safe for other future callers.
    if (mutationVersion === currentMutation) {
      state = previousState;
      notify();
      // A failed opt-in must not leave behind the context created by its
      // gesture; a failed opt-out deliberately keeps the prior context alive.
      if (patch.sound === true && !previousState.sound) disposeRequestAudio();
    }
    throw error;
  }
}

export function getNotificationPrefsSnapshot(): Readonly<Prefs> {
  return state;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getLoadedSnapshot(): boolean {
  return loaded;
}

export function useNotificationPrefs(): Prefs {
  return useSyncExternalStore(subscribe, getNotificationPrefsSnapshot, getNotificationPrefsSnapshot);
}

export function useNotificationPrefsLoaded(): boolean {
  return useSyncExternalStore(subscribe, getLoadedSnapshot, getLoadedSnapshot);
}
