const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface RequestStartedEvent {
  requestId: string;
  providerId: string | null;
  modelId: string;
  requestedModel: string;
  ttftMs: number;
  createdAt: string;
}

export interface RequestStreamCursor {
  createdAt: string;
  id: string;
}

function initialCursor(since: number | string): RequestStreamCursor {
  const date = typeof since === 'number' ? new Date(since) : new Date(since);
  return Number.isFinite(date.getTime())
    ? { createdAt: date.toISOString(), id: '' }
    : { createdAt: new Date(Date.now() - 5_000).toISOString(), id: '' };
}

/** Exponential reconnect delay with bounded jitter, suitable for shared browser tabs. */
export function requestStreamReconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(10, Math.max(0, Math.floor(attempt)));
  const base = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** exponent, MAX_RECONNECT_DELAY_MS);
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(base * jitter));
}

/**
 * Subscribe to final persisted request events. Each connection owns its own
 * EventSource reference so a delayed error from an older connection cannot
 * close or orphan a newer one.
 */
export function subscribeToRequestStream<T>(
  since: number | string,
  onRequest: (request: T) => void,
  onRequestStarted?: (event: RequestStartedEvent) => void,
): () => void {
  let cancelled = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let lastSeenCursor = initialCursor(since);

  const scheduleReconnect = (): void => {
    if (cancelled || reconnectTimer !== null) return;
    const delay = requestStreamReconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (cancelled) return;
    let nextSource: EventSource;
    try {
      const params = new URLSearchParams({ since: lastSeenCursor.createdAt });
      if (lastSeenCursor.id) params.set('afterId', lastSeenCursor.id);
      nextSource = new EventSource(`/api/admin/requests/stream?${params.toString()}`);
    } catch {
      scheduleReconnect();
      return;
    }
    source = nextSource;

    const reconnectFromLastDeliveredCursor = (): void => {
      nextSource.close();
      if (cancelled || source !== nextSource) return;
      if (stableConnectionTimer !== null) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = null;
      source = null;
      scheduleReconnect();
    };

    nextSource.addEventListener('request', (event) => {
      if (cancelled || source !== nextSource) return;
      let request: T;
      try {
        request = JSON.parse((event as MessageEvent<string>).data) as T;
      } catch {
        // A malformed frame is not a durable request event; ignore it without
        // advancing the cursor.
        return;
      }
      try {
        onRequest(request);
      } catch {
        // The consumer did not handle this durable event. Reconnect from the
        // previous cursor so the server can replay it instead of silently
        // consuming it until the next unrelated disconnect.
        reconnectFromLastDeliveredCursor();
        return;
      }
      // Preserve the full (createdAt,id) cursor. Timestamp-only cursors can
      // livelock when a replay page ends inside a large timestamp tie.
      if (request && typeof request === 'object' && 'createdAt' in request && 'id' in request) {
        const item = request as { createdAt?: unknown; id?: unknown };
        if (typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
          && typeof item.id === 'string' && item.id.length > 0) {
          // Replay is emitted in database cursor order; newly persisted live
          // completions have strictly increasing timestamps.
          lastSeenCursor = { createdAt: item.createdAt, id: item.id };
        }
      }
    });

    if (onRequestStarted) {
      nextSource.addEventListener('request_started', (event) => {
        if (cancelled || source !== nextSource) return;
        try {
          onRequestStarted(JSON.parse((event as MessageEvent<string>).data) as RequestStartedEvent);
        } catch {
          // Ignore malformed frames and callback failures; keep the stream alive.
        }
      });
    }

    nextSource.onopen = () => {
      if (source !== nextSource) return;
      if (stableConnectionTimer !== null) clearTimeout(stableConnectionTimer);
      // Only reset backoff after a connection has remained healthy for a while;
      // rapid open/error loops must not pin retries at the minimum delay.
      stableConnectionTimer = setTimeout(() => {
        stableConnectionTimer = null;
        if (source === nextSource) reconnectAttempt = 0;
      }, 30_000);
    };

    nextSource.onerror = () => {
      reconnectFromLastDeliveredCursor();
    };
  };

  connect();

  return () => {
    cancelled = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (stableConnectionTimer !== null) clearTimeout(stableConnectionTimer);
    reconnectTimer = null;
    stableConnectionTimer = null;
    const activeSource = source;
    source = null;
    activeSource?.close();
  };
}
