import { describe, expect, it } from 'vitest';
import {
  buildRequestApiQuery,
  mergeLiveRequestRows,
  matchesRequestExplorerFilters,
  parseRequestExplorerFilters,
  serializeRequestExplorerFilters,
  sortRequestRows,
  type RequestExplorerRow,
} from '../../src/web/lib/request-filters';

const row = (overrides: Partial<RequestExplorerRow> = {}): RequestExplorerRow => ({
  id: 'req-123', requestedModel: 'openai/gpt-5', clientIp: '127.0.0.1', success: false,
  httpStatus: 502, protocol: 'openai', streaming: true, createdAt: '2026-11-22T10:00:00.000Z',
  totalLatencyMs: 1200, ...overrides,
});

describe('request explorer filters', () => {
  it('parses notification deep links by exact request ID', () => {
    const filters = parseRequestExplorerFilters(new URLSearchParams('searchBy=id&search=req-123'));
    expect(filters).toMatchObject({ searchBy: 'id', search: 'req-123' });
    expect(matchesRequestExplorerFilters(row(), filters)).toBe(true);
    expect(matchesRequestExplorerFilters(row({ id: 'req-456' }), filters)).toBe(false);
  });

  it('maps status presets and search modes to existing API parameters', () => {
    const filters = parseRequestExplorerFilters(new URLSearchParams('searchBy=ip&search=127.0.0.1&status=5xx&protocol=anthropic&streaming=false'));
    const query = buildRequestApiQuery(filters, 50, 100);
    expect(query.get('ip')).toBe('127.0.0.1');
    expect(query.get('minStatus')).toBe('500');
    expect(query.get('maxStatus')).toBe('599');
    expect(query.get('protocol')).toBe('anthropic');
    expect(query.get('streaming')).toBe('false');
    expect(query.get('limit')).toBe('50');
    expect(query.get('offset')).toBe('100');
  });

  it('maps exact request IDs and model substrings to the existing server fields', () => {
    const idFilters = parseRequestExplorerFilters(new URLSearchParams('searchBy=id&search=req-123'));
    const modelFilters = parseRequestExplorerFilters(new URLSearchParams('searchBy=model&search=gpt-5'));
    expect(buildRequestApiQuery(idFilters, 50, 0).get('id')).toBe('req-123');
    expect(buildRequestApiQuery(modelFilters, 50, 0).get('requestedModel')).toBe('gpt-5');
  });

  it('parses dashboard failure deep links', () => {
    const filters = parseRequestExplorerFilters(new URLSearchParams('status=failed'));
    expect(filters.status).toBe('failed');
    expect(buildRequestApiQuery(filters, 50, 0).get('success')).toBe('false');
  });

  it('matches success, failed, and HTTP range filters against live SSE rows', () => {
    const failed4xx = row({ httpStatus: 429, success: false });
    const failed5xx = row({ httpStatus: 503, success: false });
    const successful = row({ httpStatus: 200, success: true });
    expect(matchesRequestExplorerFilters(failed4xx, { ...parseRequestExplorerFilters(new URLSearchParams()), status: '4xx' })).toBe(true);
    expect(matchesRequestExplorerFilters(failed5xx, { ...parseRequestExplorerFilters(new URLSearchParams()), status: '4xx' })).toBe(false);
    expect(matchesRequestExplorerFilters(successful, { ...parseRequestExplorerFilters(new URLSearchParams()), status: 'success' })).toBe(true);
    expect(matchesRequestExplorerFilters(successful, { ...parseRequestExplorerFilters(new URLSearchParams()), status: 'failed' })).toBe(false);
  });

  it('serializes canonical URL filters and pagination', () => {
    const filters = parseRequestExplorerFilters(new URLSearchParams('searchBy=model&search=gpt&status=failed&sort=oldest'));
    expect(serializeRequestExplorerFilters(filters, 50).toString()).toBe('searchBy=model&search=gpt&status=failed&sort=oldest&offset=50');
  });

  it('sorts only the supplied page without mutating the original rows', () => {
    const first = row({ id: 'first', totalLatencyMs: 500, createdAt: '2026-11-22T09:00:00.000Z' });
    const second = row({ id: 'second', totalLatencyMs: 1500, createdAt: '2026-11-22T11:00:00.000Z' });
    const source = [first, second];
    expect(sortRequestRows(source, 'oldest').map((item) => item.id)).toEqual(['first', 'second']);
    expect(sortRequestRows(source, 'latency-desc').map((item) => item.id)).toEqual(['second', 'first']);
    expect(source.map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('merges matching live rows that arrived during a page fetch without duplicates', () => {
    const server = row({ id: 'server', success: true, httpStatus: 200, createdAt: '2026-11-22T10:00:00.000Z' });
    const live = row({ id: 'live', success: true, httpStatus: 200, createdAt: '2026-11-22T11:00:00.000Z' });
    const duplicate = row({ id: 'server', success: true, httpStatus: 200 });
    const filteredOut = row({ id: 'failed', success: false, httpStatus: 502 });
    const filters = { ...parseRequestExplorerFilters(new URLSearchParams()), status: 'success' as const };

    const merged = mergeLiveRequestRows([server], [duplicate, live, filteredOut], filters, 50);

    expect(merged.addedCount).toBe(1);
    expect(merged.rows.map((item) => item.id)).toEqual(['live', 'server']);
  });
});
