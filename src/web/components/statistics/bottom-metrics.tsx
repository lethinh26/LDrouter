// Bottom metrics: success rate as a circular progress + average latency with sparkline.
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Sparkline } from './sparkline';
import { formatLatencyMs, formatPercent } from '../../lib/utils';

interface BottomMetricsProps {
  successRate: number;      // 0..1
  averageLatencyMs: number; // live average
  latencySpark: number[];   // series avg latency per bucket
}

const R = 34;
const CIRC = 2 * Math.PI * R;

function successColor(rate: number) {
  if (rate >= 0.95) return { stroke: '#4ade80', text: 'text-emerald-500' };
  if (rate >= 0.8) return { stroke: '#fbbf24', text: 'text-amber-500' };
  return { stroke: '#f87171', text: 'text-red-500' };
}

export function BottomMetrics({ successRate, averageLatencyMs, latencySpark }: BottomMetricsProps) {
  const { stroke, text } = successColor(successRate);
  const frac = Math.min(1, Math.max(0, successRate));
  const offset = CIRC * (1 - frac);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Success rate circular */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Success Rate</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-4">
          <div className="relative h-20 w-20">
            <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
              <circle cx="40" cy="40" r={R} fill="none" stroke="hsl(var(--border))" strokeWidth={7} />
              <circle
                cx="40" cy="40" r={R} fill="none" stroke={stroke} strokeWidth={7} strokeLinecap="round"
                strokeDasharray={CIRC} strokeDashoffset={offset}
                style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.4s ease' }}
              />
            </svg>
            <span className={`absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums ${text}`}>
              {formatPercent(successRate)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Share of requests that completed successfully over the selected window. Updated in real time.
          </p>
        </CardContent>
      </Card>

      {/* Average latency + sparkline */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Average Latency</CardTitle></CardHeader>
        <CardContent className="flex items-end justify-between">
          <div>
            <div className="text-2xl font-semibold tabular-nums">{formatLatencyMs(averageLatencyMs)}</div>
            <p className="text-xs text-muted-foreground mt-1">Live average across the selected window</p>
          </div>
          <Sparkline
            data={latencySpark}
            strokeClass="stroke-amber-500"
            fillClass="fill-amber-500/10"
            className="h-10 w-28"
          />
        </CardContent>
      </Card>
    </div>
  );
}
