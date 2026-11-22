import { describe, expect, it } from 'vitest';
import { nextRequestCompletionTimestamp } from '../../src/server/gateway/request-timestamps';

describe('nextRequestCompletionTimestamp', () => {
  it('uses the wall clock when it is later than the previous completion', () => {
    expect(nextRequestCompletionTimestamp(
      new Date('2026-11-22T12:00:00.500Z'),
      '2026-11-22T12:00:00.123Z',
    )).toBe('2026-11-22T12:00:00.500Z');
  });

  it('advances by one millisecond when completions share a millisecond', () => {
    expect(nextRequestCompletionTimestamp(
      new Date('2026-11-22T12:00:00.123Z'),
      '2026-11-22T12:00:00.123Z',
    )).toBe('2026-11-22T12:00:00.124Z');
  });

  it('keeps completion order monotonic when the system clock moves backwards', () => {
    expect(nextRequestCompletionTimestamp(
      new Date('2026-11-22T11:59:59.000Z'),
      '2026-11-22T12:00:00.123Z',
    )).toBe('2026-11-22T12:00:00.124Z');
  });

  it('advances beyond historical timestamps with sub-millisecond precision', () => {
    expect(nextRequestCompletionTimestamp(
      new Date('2026-11-22T12:00:00.123Z'),
      '2026-11-22T12:00:00.123456Z',
    )).toBe('2026-11-22T12:00:00.124Z');
  });

  it('rejects malformed persisted timestamps rather than emitting an unsafe cursor', () => {
    expect(() => nextRequestCompletionTimestamp(new Date(), 'not-a-date')).toThrow(RangeError);
  });
});
