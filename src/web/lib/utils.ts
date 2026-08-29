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
