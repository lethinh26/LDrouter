// Stacked request notification cards (top-right). Clicking a card opens its request filter.
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, X, MinusCircle } from 'lucide-react';
import { cn, formatLatencyMs, formatNumber } from '../lib/utils';
import type { RequestNotificationItem } from '../lib/request-events';

interface Props {
  items: RequestNotificationItem[];
  onDismiss: (id: string) => void;
}

export function RequestNotifications({ items, onDismiss }: Props) {
  return (
    <div role="region" aria-label="Request notifications" aria-live="polite" aria-relevant="additions" aria-atomic="false" className="pointer-events-none fixed left-3 right-3 top-16 z-50 flex max-h-[calc(100vh-8rem)] flex-col gap-2 overflow-y-auto sm:left-auto sm:right-4 sm:w-80">
      {items.map((item) => {
        const isCancelled = item.httpStatus === 499 || /client[_-]?disconnected|cancel|abort|disconnect/i.test(item.errorType ?? '');
        const isError = !item.success && !isCancelled;
        const isSlow = item.success && item.totalLatencyMs > 15_000;
        const cardClass = cn(
          'rounded-md border shadow-lg transition-all',
          isError && 'bg-destructive text-destructive-foreground border-destructive',
          isSlow && 'bg-amber-500/90 text-amber-950 border-amber-600/50',
          !isError && !isSlow && 'bg-card text-card-foreground border-border',
          isCancelled && 'bg-muted text-muted-foreground border-border'
        );

        return (
          <div key={item.id} className={cn('pointer-events-auto relative shrink-0', cardClass)}>
            <Link to={`/requests?searchBy=id&search=${encodeURIComponent(item.id)}`} className="block p-3 pr-10 hover:opacity-95">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {isCancelled ? <MinusCircle className="h-4 w-4 shrink-0" /> : isError ? (
                  <XCircle className="h-4 w-4 shrink-0" />
                ) : item.success ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : null}
                <div className="min-w-0 truncate text-sm font-medium" title={item.requestedModel}>
                  {item.requestedModel}
                </div>
              </div>
              <div className="mt-1 text-xs">{isCancelled ? 'Đã hủy' : item.success ? 'Thành công' : 'Thất bại'}{isError && item.errorType && (
                <span className="ml-1 inline-block rounded bg-black/15 px-1 py-0.5 align-text-bottom text-[10px]">
                  {item.errorType}
                </span>
              )}</div>
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
            <button
              className="absolute right-3 top-3 rounded-sm p-1 opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onDismiss(item.id)}
              aria-label={`Dismiss notification for ${item.requestedModel}`}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
