// Test-only: push and reset mock upstream handlers.
import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void;
const handlers: Handler[] = [];
let hits = 0;

export function pushHandler(h: Handler) { handlers.push(h); }
export function reset() { handlers.length = 0; hits = 0; }
export function take(): Handler | undefined {
  const h = handlers[handlers.length - 1];
  if (h) hits += 1;
  return h;
}
/** Number of upstream requests served since the last reset(). */
export function callCount(): number { return hits; }
