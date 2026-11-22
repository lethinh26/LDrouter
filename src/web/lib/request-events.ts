// Live request notifications: subscribes to final persisted request events over SSE.
// Each notification auto-dismisses after 5s and can be closed manually.
// Card visibility and sound are independently gated by Settings prefs.
import { useEffect, useRef, useState } from 'react';
import { useNotificationPrefs, getNotificationPrefsSnapshot, loadNotificationPrefs } from './notification-settings';
import { classifyRequestSound, cancelPendingAudioDisposal, disposeRequestAudio, installAudioUnlockListeners, playRequestSound } from './sound-feedback';
import { subscribeToRequestStream } from './request-stream';

export interface RequestNotificationItem {
  id: string;
  requestedModel: string;
  success: boolean;
  errorType: string | null;
  httpStatus: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalLatencyMs: number;
  ttftMs: number | null;
  createdAt: string;
}

const DISMISS_MS = 5000; // auto-dismiss after 5 seconds
const MAX_ITEMS = 8; // cap visible cards at once
const MAX_SEEN_IDS = 2000;
const PREF_RETRY_MS = 5000;

export function useRequestNotifications(): { items: RequestNotificationItem[]; dismiss: (id: string) => void } {
  const [items, setItems] = useState<RequestNotificationItem[]>([]);
  const [prefsReady, setPrefsReady] = useState(false);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Keep the initial replay boundary stable for this notification session;
  // subscribeToRequestStream advances its own cursor after each handled event.
  const sessionStartedAtRef = useRef<number | null>(null);
  // IDs already surfaced as a notification. The SSE stream replays recent
  // rows after `since` on every (re)connect, so without this set a reconnect
  // would re-show replayed rows as "new" — the ghost notification (card +
  // sound) with no actual new request behind it.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const prefs = useNotificationPrefs();

  // Do not open the SSE stream or unlock audio until the persisted preferences
  // have loaded; otherwise a stored opt-out could briefly play a sound on boot.
  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      const ready = await loadNotificationPrefs();
      if (!active) return;
      if (ready) setPrefsReady(true);
      else retryTimer = setTimeout(() => { retryTimer = null; void load(); }, PREF_RETRY_MS);
    };
    void load();
    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, []);

  const shouldListen = prefsReady && (prefs.enabled || prefs.sound);

  useEffect(() => () => disposeRequestAudio(), []);

  // Enabling sound cancels preview-only disposal. Disabling is finalized by
  // saveNotificationPrefs only after its PATCH succeeds, so rollback preserves
  // the currently unlocked context.
  useEffect(() => {
    if (prefsReady && prefs.sound) cancelPendingAudioDisposal();
  }, [prefsReady, prefs.sound]);

  useEffect(() => {
    if (!prefsReady || !prefs.sound) return;
    return installAudioUnlockListeners();
  }, [prefsReady, prefs.sound]);

  useEffect(() => {
    const timers = timersRef.current;
    if (!prefs.enabled) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      setItems([]);
    }

    if (!shouldListen) {
      // Both notification channels are off: tear down the stream and clear cards.
      // A later opt-in starts a new notification session; do not replay events
      // that completed while the user had explicitly disabled both channels.
      sessionStartedAtRef.current = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      setItems([]);
      return;
    }

    let cancelled = false;
    // Start the replay window only after persisted preferences allow this
    // channel to listen, so boot-time requests are not surfaced retroactively.
    sessionStartedAtRef.current ??= Date.now();
    const unsubscribe = subscribeToRequestStream<RequestNotificationItem>(sessionStartedAtRef.current, (data) => {
      if (cancelled || !data || typeof data.id !== 'string' || !data.id) return;
      if (seenIdsRef.current.has(data.id)) return; // replay duplicate — already alerted
      seenIdsRef.current.add(data.id);
      if (seenIdsRef.current.size > MAX_SEEN_IDS) {
        const oldestId = seenIdsRef.current.values().next().value;
        if (oldestId) seenIdsRef.current.delete(oldestId);
      }

      const currentPrefs = getNotificationPrefsSnapshot();
      if (currentPrefs.enabled) {
        setItems((prev) => {
          if (prev.some((i) => i.id === data.id)) return prev;
          return [data, ...prev].slice(0, MAX_ITEMS);
        });
        if (timers.size >= MAX_ITEMS) {
          const oldestId = timers.keys().next().value;
          if (oldestId) {
            const oldestTimer = timers.get(oldestId);
            if (oldestTimer) clearTimeout(oldestTimer);
            timers.delete(oldestId);
          }
        }
        const t = setTimeout(() => {
          setItems((prev) => prev.filter((i) => i.id !== data.id));
          timers.delete(data.id);
        }, DISMISS_MS);
        timers.set(data.id, t);
      }

      if (currentPrefs.sound) {
        const soundKind = classifyRequestSound(data);
        if (soundKind) playRequestSound(soundKind);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [prefs.enabled, shouldListen]);

  const dismiss = (id: string): void => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  return { items, dismiss };
}
