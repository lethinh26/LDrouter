// Internal event bus: notifies subscribers when a gateway request row is persisted.
// Fire-and-forget: listeners must never affect the request path.

import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(50);

const REQUEST_LOGGED = 'request_logged';
const REQUEST_STARTED = 'request_started';

export function emitRequestLogged(requestId: string): void {
  try {
    bus.emit(REQUEST_LOGGED, requestId);
  } catch {
    // Never let listener failures affect the request path.
  }
}

export function emitRequestStarted(requestId: string, providerId: string | null, modelId: string, requestedModel: string, ttftMs: number): void {
  try {
    bus.emit(REQUEST_STARTED, { requestId, providerId, modelId, requestedModel, ttftMs });
  } catch {
    // Never let listener failures affect the request path.
  }
}

export function onRequestLogged(cb: (requestId: string) => void): void {
  bus.on(REQUEST_LOGGED, cb);
}

export function onRequestStarted(cb: (data: { requestId: string; providerId: string | null; modelId: string; requestedModel: string; ttftMs: number }) => void): void {
  bus.on(REQUEST_STARTED, cb);
}

export function offRequestLogged(cb: (requestId: string) => void): void {
  bus.off(REQUEST_LOGGED, cb);
}

export function offRequestStarted(cb: (data: { requestId: string; providerId: string | null; modelId: string; requestedModel: string; ttftMs: number }) => void): void {
  bus.off(REQUEST_STARTED, cb);
}
