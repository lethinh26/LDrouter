// Live request notifications: subscribes to the SSE stream and play a sound per event.
// Each notification auto-dismisses after 5s and can be closed manually.
import { useEffect, useRef, useState } from 'react';

export interface RequestNotificationItem {
  id: string;
  requestedModel: string;
  success: boolean;
  errorType: string | null;
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
const RECONNECT_MS = 3000;

// Single shared Audio object; lazy-created so the first notification also primes the autoplay gesture.
let sound: HTMLAudioElement | null = null;
function playSound(): void {
  try {
    if (!sound) sound = new Audio('/notification.mp3');
    sound.currentTime = 0;
    void sound.play().catch(() => { /* autoplay blocked until first user interaction — ignore */ });
  } catch { /* never let audio break notifications */ }
}

export function useRequestNotifications(): { items: RequestNotificationItem[]; dismiss: (id: string) => void } {
  const [items, setItems] = useState<RequestNotificationItem[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastSeenRef = useRef<number>(Date.now()); // epoch ms, sent as `since` on (re)connect

  useEffect(() => {
    let cancelled = false;
    const timers = timersRef.current; // stable across the effect lifetime

    const connect = (): void => {
      if (cancelled) return;
      const es = new EventSource(`/api/admin/requests/stream?since=${lastSeenRef.current}`);
      esRef.current = es;

      es.addEventListener('request', (ev) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((ev as MessageEvent).data as string) as RequestNotificationItem;
          const seenMs = new Date(data.createdAt).getTime();
          if (Number.isFinite(seenMs)) lastSeenRef.current = Math.max(lastSeenRef.current, seenMs);
          setItems((prev) => {
            if (prev.some((i) => i.id === data.id)) return prev;
            return [data, ...prev].slice(0, MAX_ITEMS);
          });
          const t = setTimeout(() => {
            setItems((prev) => prev.filter((i) => i.id !== data.id));
            timers.delete(data.id);
          }, DISMISS_MS);
          timers.set(data.id, t);
          playSound();
        } catch { /* malformed event — ignore */ }
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        // Reconnect after a short delay with the last seen timestamp so nothing is lost.
        if (!cancelled) setTimeout(connect, RECONNECT_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

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
