import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { watchDownstreamDisconnect } from '../../src/server/gateway/downstream';
import { preserveClientDisconnect } from '../../src/server/errors';

function responseState(overrides: { writableEnded?: boolean; destroyed?: boolean; closed?: boolean } = {}) {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    closed: false,
    ...overrides,
  });
}

describe('downstream disconnect watcher', () => {
  it('detects a socket that closed before listener registration', () => {
    const response = responseState({ destroyed: true, closed: true });
    const onDisconnect = vi.fn();
    const detach = watchDownstreamDisconnect(response, onDisconnect);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    response.emit('close');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    detach();
  });

  it('observes a close after registration exactly once', () => {
    const response = responseState();
    const onDisconnect = vi.fn();
    const detach = watchDownstreamDisconnect(response, onDisconnect);

    response.destroyed = true;
    response.closed = true;
    response.emit('close');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    detach();
  });

  it('does not classify a normal ended response as a disconnect', () => {
    const response = responseState({ writableEnded: true, destroyed: true, closed: true });
    const onDisconnect = vi.fn();
    const detach = watchDownstreamDisconnect(response, onDisconnect);

    response.emit('close');
    expect(onDisconnect).not.toHaveBeenCalled();
    detach();
  });

  it('maps a credential-preflight failure that completes after disconnect', async () => {
    const downstream = new AbortController();
    let rejectRefresh!: (error: Error) => void;
    const pending = preserveClientDisconnect(downstream.signal, () => new Promise<never>((_resolve, reject) => {
      rejectRefresh = reject;
    }));

    downstream.abort();
    rejectRefresh(new Error('credential refresh failed'));

    await expect(pending).rejects.toMatchObject({ code: 'client_disconnected', status: 499 });
  });

  it('does not start credential preflight if the client is already disconnected', async () => {
    const downstream = new AbortController();
    downstream.abort();
    const operation = vi.fn(async () => 'should not run');

    await expect(preserveClientDisconnect(downstream.signal, operation)).rejects.toMatchObject({ code: 'client_disconnected', status: 499 });
    expect(operation).not.toHaveBeenCalled();
  });
});
