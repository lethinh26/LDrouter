// Summary card: icon + animated count-up + delta badge + optional sparkline.
import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Sparkline } from './sparkline';
import { formatNumber, formatPercent, formatLatencyMs, cn } from '../../lib/utils';
import type { LucideIcon } from 'lucide-react';

interface SummaryCardProps {
  icon: LucideIcon;
  label: string;
  value: number;
  format?: 'number' | 'percent' | 'latency';
  delta?: number; // relative change vs previous period (> 0 = increase)
  deltaInverse?: boolean; // true for latency/TTFT where decrease = positive
  sparkData?: number[];
  sparkStroke?: string;
}

function animateCount(target: number, ms: number, cb: (v: number) => void) {
  const start = performance.now();
  let prev = 0;
  const step = (now: number) => {
    const t = Math.min((now - start) / ms, 1);
    const v = Math.round(target * t);
    if (v !== prev) { prev = v; cb(v); }
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function DeltaBadge({ delta, inverse }: { delta: number; inverse?: boolean }) {
  if (Math.abs(delta) < 0.005) return null;
  const up = delta > 0;
  const positive = inverse ? !up : up; // good direction
  const pct = `${(Math.abs(delta) * 100).toFixed(1)}%`;
  return (
    <span className={cn(
      'ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
      positive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
               : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    )}>
      <span className="mr-0.5">{up ? '▲' : '▼'}</span>{pct}
    </span>
  );
}

export function SummaryCard({ icon: Icon, label, value, format = 'number', delta, deltaInverse, sparkData, sparkStroke }: SummaryCardProps) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    prevRef.current = value;
    if (from === to) return;
    animateCount(Math.abs(to - from), 600, (v) => setDisplay(from + (to > from ? v : -v)));
  }, [value]);

  const formatted = format === 'percent' ? formatPercent(display)
    : format === 'latency' ? formatLatencyMs(display)
    : formatNumber(Math.round(display));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-1">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="h-4 w-4" />
          {label}
        </CardTitle>
        {delta !== undefined && <DeltaBadge delta={delta} inverse={deltaInverse} />}
      </CardHeader>
      <CardContent className="flex items-end justify-between">
        <span className="text-2xl font-semibold tabular-nums">{formatted}</span>
        {sparkData && sparkData.length > 1 && (
          <Sparkline data={sparkData} strokeClass={sparkStroke ?? 'stroke-primary'} fillClass="fill-primary/10" />
        )}
      </CardContent>
    </Card>
  );
}
