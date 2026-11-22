import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestStreamReconnectDelay, subscribeToRequestStream } from '@web/lib/request-stream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emitRequest(data: unknown): void {
    this.listeners.get('request')?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  emitRequestStarted(data: unknown): void {
    this.listeners.get('request_started')?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }
}

describe('request stream subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('parses request events and ignores delayed errors from superseded connections', () => {
    const onRequest = vi.fn();
    const unsubscribe = subscribeToRequestStream<{ id: string }>(123, onRequest);
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe('/api/admin/requests/stream?since=1970-01-01T00%3A00%3A00.123Z');

    first.emitRequest({ id: 'req-1' });
    expect(onRequest).toHaveBeenCalledWith({ id: 'req-1' });

    first.fail();
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1]!;

    // A late error from the old EventSource must not close the replacement.
    first.fail();
    expect(second.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(2);
    second.emitRequest({ id: 'req-2' });
    expect(onRequest).toHaveBeenLastCalledWith({ id: 'req-2' });

    unsubscribe();
    expect(second.closed).toBe(true);
  });

  it('advances the replay cursor after each handled request and resumes from it', () => {
    const onRequest = vi.fn();
    const unsubscribe = subscribeToRequestStream<{ id: string; createdAt: string }>(100, onRequest);
    const first = FakeEventSource.instances[0]!;
    first.emitRequest({ id: 'req-1', createdAt: new Date(456).toISOString() });
    first.fail();

    vi.advanceTimersByTime(3000);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe('/api/admin/requests/stream?since=1970-01-01T00%3A00%3A00.456Z&afterId=req-1');
    second.emitRequest({ id: 'req-2', createdAt: new Date(456).toISOString() });
    second.fail();

    vi.advanceTimersByTime(6000);
    expect(FakeEventSource.instances[2]!.url).toBe('/api/admin/requests/stream?since=1970-01-01T00%3A00%3A00.456Z&afterId=req-2');
    unsubscribe();
  });

  it('reconnects from the last delivered cursor when the consumer throws', () => {
    const onRequest = vi.fn(() => {
      throw new Error('consumer failed');
    });
    const unsubscribe = subscribeToRequestStream<{ id: string; createdAt: string }>(100, onRequest);
    const first = FakeEventSource.instances[0]!;
    first.emitRequest({ id: 'req-1', createdAt: new Date(456).toISOString() });
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(3000);
    expect(FakeEventSource.instances[1]!.url).toBe('/api/admin/requests/stream?since=1970-01-01T00%3A00%3A00.100Z');
    unsubscribe();
  });

  it('delivers request_started events without advancing the final-request replay cursor', () => {
    const onRequestStarted = vi.fn();
    const unsubscribe = subscribeToRequestStream(123, () => undefined, onRequestStarted);
    const first = FakeEventSource.instances[0]!;
    first.emitRequestStarted({
      requestId: 'req-started', providerId: 'provider-1', modelId: 'model-1',
      requestedModel: 'gpt-test', ttftMs: 42, createdAt: new Date(999).toISOString(),
    });
    expect(onRequestStarted).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-started', ttftMs: 42 }));

    first.fail();
    vi.advanceTimersByTime(3000);
    expect(FakeEventSource.instances[1]!.url).toBe('/api/admin/requests/stream?since=1970-01-01T00%3A00%3A00.123Z');
    unsubscribe();
  });

  it('backs off across rapid open/error loops and resets only after a stable connection', () => {
    const unsubscribe = subscribeToRequestStream(0, () => undefined);
    const first = FakeEventSource.instances[0]!;
    first.fail();
    vi.advanceTimersByTime(3000);
    const second = FakeEventSource.instances[1]!;
    second.open();
    second.fail();

    vi.advanceTimersByTime(5999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    const third = FakeEventSource.instances[2]!;
    third.open();
    vi.advanceTimersByTime(30_000);
    third.fail();
    vi.advanceTimersByTime(2999);
    expect(FakeEventSource.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(4);
    unsubscribe();
  });

  it('clears a pending reconnect when unsubscribed', () => {
    const unsubscribe = subscribeToRequestStream(0, () => undefined);
    const first = FakeEventSource.instances[0]!;
    first.fail();
    unsubscribe();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(true);
  });

  it('uses bounded exponential backoff with jitter', () => {
    expect(requestStreamReconnectDelay(0, () => 0.5)).toBe(3000);
    expect(requestStreamReconnectDelay(1, () => 0.5)).toBe(6000);
    expect(requestStreamReconnectDelay(2, () => 0.5)).toBe(12_000);
    expect(requestStreamReconnectDelay(20, () => 0.5)).toBe(30_000);
    expect(requestStreamReconnectDelay(20, () => 1)).toBe(30_000);
  });
});
