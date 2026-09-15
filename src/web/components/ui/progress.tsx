// Minimal shadcn-shaped progress bar. A div-based track avoids adding a Radix dependency
// for what is one styled element.
import { cn } from '../../lib/utils';

export function Progress({ value, className, indicatorClassName }: { value: number; className?: string; indicatorClassName?: string }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className={cn('h-2 w-full overflow-hidden rounded-full bg-secondary', className)}>
      <div className={cn('h-full w-full flex-1 bg-primary transition-all', indicatorClassName)} style={{ transform: `translateX(-${100 - pct}%)` }} />
    </div>
  );
}
