import { describe, expect, it } from 'vitest';
import { classifyRequestSound } from '../../src/web/lib/sound-feedback';

describe('classifyRequestSound', () => {
  it('uses a success tone for successful requests', () => {
    expect(classifyRequestSound({ success: true, errorType: null, httpStatus: 200 })).toBe('success');
  });

  it('uses the HTTP error tone for ordinary HTTP failures', () => {
    expect(classifyRequestSound({ success: false, errorType: 'upstream_rate_limit', httpStatus: 429 })).toBe('http-error');
    expect(classifyRequestSound({ success: false, errorType: 'upstream_error', httpStatus: 502 })).toBe('http-error');
    expect(classifyRequestSound({ success: false, errorType: 'gateway_error', httpStatus: 500 })).toBe('http-error');
  });

  it('uses the network tone for the persisted upstream-unavailable category', () => {
    expect(classifyRequestSound({ success: false, errorType: 'upstream_unavailable', httpStatus: 502 })).toBe('network-error');
  });

  it('uses the timeout tone for the persisted canonical timeout category', () => {
    expect(classifyRequestSound({ success: false, errorType: 'timeout_error', httpStatus: 504 })).toBe('timeout');
  });

  it('does not play a tone for client cancellation or disconnect', () => {
    expect(classifyRequestSound({ success: false, errorType: 'gateway_error', httpStatus: 499 })).toBeNull();
    expect(classifyRequestSound({ success: false, errorType: 'client_disconnected', httpStatus: 500 })).toBeNull();
    expect(classifyRequestSound({ success: false, errorType: null, httpStatus: 499 })).toBeNull();
  });
});
