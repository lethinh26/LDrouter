// Utility for className composition.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number | null | undefined, fallback = '—'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return fallback;
  return n.toLocaleString();
}

export function formatPercent(n: number | null | undefined, digits = 1, fallback = '—'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return fallback;
  return `${(n * 100).toFixed(digits)}%`;
}

export function formatLatencyMs(n: number | null | undefined): string {
  if (!n) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function formatDateTime(s: string | null | undefined): string {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export function shortId(s: string | null | undefined, n = 8): string {
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function formatTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
