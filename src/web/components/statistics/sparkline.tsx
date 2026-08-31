// Minimal dependency-free SVG sparkline.
import { cn } from '../../lib/utils';

interface SparklineProps {
  data: number[];
  className?: string;
  strokeClass?: string; // tailwind stroke-* class, e.g. "stroke-primary"
  fillClass?: string;   // optional fill for area, e.g. "fill-primary/10"
}

export function Sparkline({ data, className, strokeClass = 'stroke-primary', fillClass }: SparklineProps) {
  const w = 80;
  const h = 24;
  if (data.length === 0) return <svg className={cn('h-6 w-20', className)} viewBox={`0 0 ${w} ${h}`} />;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (w - 2) + 1;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = pts.join(' ');
  return (
    <svg className={cn('h-6 w-20', className)} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {fillClass && <polygon points={`1,${h - 1} ${line} ${w - 1},${h - 1}`} className={fillClass} />}
      <polyline points={line} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={strokeClass} />
    </svg>
  );
}
