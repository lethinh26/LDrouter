// Stacked request notification cards (top-right). All visible simultaneously; click navigates to /requests.
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, X, Zap } from 'lucide-react';
import { cn, formatLatencyMs, formatNumber } from '../lib/utils';
import type { RequestNotificationItem } from '../lib/request-events';

interface Props {
  items: RequestNotificationItem[];
  onDismiss: (id: string) => void;
}

export function RequestNotifications({ items, onDismiss }: Props) {
  if (!items.length) return null;

  return (
    <div className="fixed top-16 right-4 z-50 flex max-h-[calc(100vh-8rem)] w-80 flex-col gap-2 overflow-y-auto">
      {items.map((item) => {
        const isError = !item.success;
        const isSlow = item.success && item.totalLatencyMs > 15_000;
        const cardClass = cn(
          'rounded-md border shadow-lg transition-all',
          isError && 'bg-destructive text-destructive-foreground border-destructive',
          isSlow && 'bg-amber-500/90 text-amber-950 border-amber-600/50',
          !isError && !isSlow && 'bg-card text-card-foreground border-border'
        );

        return (
          <Link key={item.id} to="/requests" className={cn('block shrink-0 p-3 hover:opacity-95', cardClass)}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {isError ? (
                  <XCircle className="h-4 w-4 shrink-0" />
                ) : item.success ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <Zap className="h-4 w-4 shrink-0 opacity-70" />
                )}
                <div className="min-w-0 truncate text-sm font-medium" title={item.requestedModel}>
                  {item.requestedModel}
                </div>
              </div>
              <button
                className="shrink-0 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDismiss(item.id);
                }}
                aria-label="Dismiss"
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-1 text-xs">
              {item.success ? 'Thành công' : 'Thất bại'}
              {!item.success && item.errorType && (
                <span className="ml-1 inline-block rounded bg-black/15 px-1 py-0.5 align-text-bottom text-[10px]">
                  {item.errorType}
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] opacity-90">
              in {formatNumber(item.inputTokens)} · out {formatNumber(item.outputTokens)}
              {(item.cacheReadTokens > 0 || item.cacheWriteTokens > 0) && (
                <>
                  {' · cache '}
                  {item.cacheReadTokens > 0 && <span>r{formatNumber(item.cacheReadTokens)}</span>}
                  {item.cacheReadTokens > 0 && item.cacheWriteTokens > 0 && '/'}
                  {item.cacheWriteTokens > 0 && <span>w{formatNumber(item.cacheWriteTokens)}</span>}
                </>
              )}
            </div>
            <div className="mt-1 text-[11px] opacity-90">
              {formatLatencyMs(item.totalLatencyMs)}
              {item.ttftMs != null && item.ttftMs >= 0 && <span> · TTFT {formatLatencyMs(item.ttftMs)}</span>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
