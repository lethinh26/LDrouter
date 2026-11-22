export type RequestSearchBy = 'model' | 'id' | 'ip';
export type RequestStatusFilter = 'all' | 'success' | 'failed' | '4xx' | '5xx';
export type RequestSort = 'newest' | 'oldest' | 'latency-desc' | 'latency-asc';

export interface RequestExplorerFilters {
  searchBy: RequestSearchBy;
  search: string;
  status: RequestStatusFilter;
  protocol: 'all' | 'openai' | 'anthropic';
  streaming: 'all' | 'true' | 'false';
  sort: RequestSort;
}

export interface RequestExplorerRow {
  id: string;
  requestedModel: string;
  clientIp: string;
  success: boolean;
  httpStatus: number;
  protocol: 'openai' | 'anthropic';
  streaming: boolean;
  createdAt: string;
  totalLatencyMs: number;
}

export const DEFAULT_REQUEST_FILTERS: RequestExplorerFilters = {
  searchBy: 'model',
  search: '',
  status: 'all',
  protocol: 'all',
  streaming: 'all',
  sort: 'newest',
};

const isOneOf = <T extends string>(value: string | null, values: readonly T[]): value is T =>
  value !== null && values.includes(value as T);

export function parseRequestExplorerFilters(params: URLSearchParams): RequestExplorerFilters {
  const legacySearch = params.get('search') ?? params.get('requestedModel') ?? params.get('id') ?? params.get('ip') ?? '';
  const searchBy = isOneOf(params.get('searchBy'), ['model', 'id', 'ip'] as const)
    ? params.get('searchBy') as RequestSearchBy
    : params.has('id') ? 'id' : params.has('ip') ? 'ip' : 'model';
  const legacySuccess = params.get('success');
  const legacyMinStatus = Number(params.get('minStatus'));
  const legacyMaxStatus = Number(params.get('maxStatus'));
  let status: RequestStatusFilter = 'all';
  if (isOneOf(params.get('status'), ['all', 'success', 'failed', '4xx', '5xx'] as const)) {
    status = params.get('status') as RequestStatusFilter;
  } else if (legacySuccess === 'true') {
    status = 'success';
  } else if (legacySuccess === 'false') {
    status = 'failed';
  } else if (legacyMinStatus >= 400 && legacyMaxStatus <= 499 && legacyMaxStatus >= legacyMinStatus) {
    status = '4xx';
  } else if (legacyMinStatus >= 500 && legacyMaxStatus <= 599 && legacyMaxStatus >= legacyMinStatus) {
    status = '5xx';
  }

  return {
    searchBy,
    search: legacySearch,
    status,
    protocol: isOneOf(params.get('protocol'), ['all', 'openai', 'anthropic'] as const)
      ? params.get('protocol') as RequestExplorerFilters['protocol'] : 'all',
    streaming: isOneOf(params.get('streaming'), ['all', 'true', 'false'] as const)
      ? params.get('streaming') as RequestExplorerFilters['streaming'] : 'all',
    sort: isOneOf(params.get('sort'), ['newest', 'oldest', 'latency-desc', 'latency-asc'] as const)
      ? params.get('sort') as RequestSort : 'newest',
  };
}

/** URL state is canonical and shareable; sort is intentionally client-side for the current page. */
export function serializeRequestExplorerFilters(filters: RequestExplorerFilters, offset = 0): URLSearchParams {
  const params = new URLSearchParams();
  const search = filters.search.trim();
  if (search) {
    params.set('searchBy', filters.searchBy);
    params.set('search', search);
  }
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.protocol !== 'all') params.set('protocol', filters.protocol);
  if (filters.streaming !== 'all') params.set('streaming', filters.streaming);
  if (filters.sort !== 'newest') params.set('sort', filters.sort);
  if (offset > 0) params.set('offset', String(offset));
  return params;
}

/** Translate UI filters to the existing GET /api/admin/requests query contract. */
export function buildRequestApiQuery(filters: RequestExplorerFilters, limit: number, offset: number): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  switch (filters.status) {
    case 'success': params.set('success', 'true'); break;
    case 'failed': params.set('success', 'false'); break;
    case '4xx': params.set('minStatus', '400'); params.set('maxStatus', '499'); break;
    case '5xx': params.set('minStatus', '500'); params.set('maxStatus', '599'); break;
  }
  if (filters.protocol !== 'all') params.set('protocol', filters.protocol);
  if (filters.streaming !== 'all') params.set('streaming', filters.streaming);
  const search = filters.search.trim();
  if (search) {
    const key = filters.searchBy === 'model' ? 'requestedModel' : filters.searchBy;
    params.set(key, search);
  }
  return params;
}

export function matchesRequestExplorerFilters(row: RequestExplorerRow, filters: RequestExplorerFilters): boolean {
  if (filters.status === 'success' && !row.success) return false;
  if (filters.status === 'failed' && row.success) return false;
  if (filters.status === '4xx' && (row.httpStatus < 400 || row.httpStatus > 499)) return false;
  if (filters.status === '5xx' && (row.httpStatus < 500 || row.httpStatus > 599)) return false;
  if (filters.protocol !== 'all' && row.protocol !== filters.protocol) return false;
  if (filters.streaming !== 'all' && row.streaming !== (filters.streaming === 'true')) return false;

  const search = filters.search.trim().toLowerCase();
  if (!search) return true;
  if (filters.searchBy === 'id') return row.id.toLowerCase() === search;
  if (filters.searchBy === 'ip') return row.clientIp.toLowerCase() === search;
  return row.requestedModel.toLowerCase().includes(search);
}

export function sortRequestRows<T extends RequestExplorerRow>(rows: T[], sort: RequestSort): T[] {
  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'oldest': return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      case 'latency-desc': return b.totalLatencyMs - a.totalLatencyMs;
      case 'latency-asc': return a.totalLatencyMs - b.totalLatencyMs;
      case 'newest':
      default: return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    }
  });
}

/** Merge SSE rows received while a page fetch was in flight without losing them to the response. */
export function mergeLiveRequestRows<T extends RequestExplorerRow>(
  serverRows: T[],
  liveRows: T[],
  filters: RequestExplorerFilters,
  limit: number,
): { rows: T[]; addedCount: number } {
  const ids = new Set(serverRows.map((row) => row.id));
  const additions: T[] = [];
  for (const row of liveRows) {
    if (ids.has(row.id) || !matchesRequestExplorerFilters(row, filters)) continue;
    ids.add(row.id);
    additions.push(row);
  }
  return {
    rows: sortRequestRows([...serverRows, ...additions], filters.sort).slice(0, Math.max(0, limit)),
    addedCount: additions.length,
  };
}
