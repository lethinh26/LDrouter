import { describe, expect, it } from 'vitest';
import { requestLogFields, requestLogLevel, requestLogMessage } from '@server/logging/debug';

describe('request logging', () => {
  it('maps HTTP status to the Docker log level', () => {
    expect(requestLogLevel(200)).toBe('info');
    expect(requestLogLevel(404)).toBe('warn');
    expect(requestLogLevel(503)).toBe('error');
  });

  it('creates complete request fields without request bodies or secrets', () => {
    expect(requestLogFields('req_123', 'GET', '/health?token=secret', 200, 4, '/health')).toEqual({
      requestId: 'req_123', method: 'GET', url: '/health', route: '/health', statusCode: 200, durationMs: 4,
    });
    expect(requestLogMessage(200)).toBe('request completed');
    expect(requestLogMessage(404)).toBe('request completed with client error');
    expect(requestLogMessage(500)).toBe('request completed with server error');
  });
});