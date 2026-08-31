// Routing flow visualization: Incoming Traffic → AI Gateway → Providers.
// Curved SVG paths with animated pulse dots along each active route.
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import type { RoutingProviderShape, Pulse } from '../../lib/use-live-stats';

interface RoutingFlowProps {
  liveRequests: number;
  successRate: number;
  providers: RoutingProviderShape[];
  pulses: Pulse[];
}

const SVG_W = 1000;
const SVG_H = 380;
// Layout columns (x coordinates)
const INCOMING_X = 60;
const GATEWAY_X = SVG_W / 2;
const PROVIDER_START_X = 720;
const PROVIDER_SPACING = 62;
const PROVIDER_COL_W = 260;

function healthColor(h: string) {
  if (h === 'healthy') return 'fill-emerald-400';
  if (h === 'degraded') return 'fill-amber-400';
  return 'fill-red-400';
}

function curvedPath(fromX: number, fromY: number, toX: number, toY: number) {
  const cpx1 = fromX + (toX - fromX) * 0.45;
  const cpx2 = fromX + (toX - fromX) * 0.55;
  return `M${fromX},${fromY} C${cpx1},${fromY} ${cpx2},${toY} ${toX},${toY}`;
}

export function RoutingFlow({ liveRequests, successRate, providers, pulses }: RoutingFlowProps) {
  const gatewayY = SVG_H / 2;
  const incomingY = gatewayY;
  const totalTraffic = Math.max(1, providers.reduce((a, p) => a + p.requests, 0));

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Real-time Request Routing</CardTitle>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> healthy</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> degraded</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-red-400" /> down</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="relative w-full">
          {/* SVG diagram */}
          <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
            {/* Defs: pulse glow filter */}
            <defs>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {/* ── Curved paths: Gateway → each Provider ── */}
            {providers.map((p) => {
              const idx = providers.indexOf(p);
              const py = 60 + idx * PROVIDER_SPACING;
              const pct = p.requests / totalTraffic;
              const strokeW = Math.max(1.5, Math.min(6, 2 + pct * 8));
              return (
                <path
                  key={p.id}
                  d={curvedPath(GATEWAY_X, gatewayY, PROVIDER_START_X - 20, py)}
                  fill="none"
                  stroke="hsl(var(--border))"
                  strokeWidth={strokeW}
                  strokeLinecap="round"
                  opacity={0.6}
                />
              );
            })}

            {/* Incoming path */}
            <path d={curvedPath(INCOMING_X + 30, incomingY, GATEWAY_X - 30, gatewayY)} fill="none" stroke="hsl(var(--border))" strokeWidth={3} strokeLinecap="round" strokeDasharray="6 3" opacity={0.5} />

            {/* ── Pulse dots along each route ── */}
            {pulses.map((pulse) => {
              const idx = providers.findIndex((p) => p.id === pulse.providerId);
              if (idx === -1) return null;
              const py = 60 + idx * PROVIDER_SPACING;
              const pathD = curvedPath(GATEWAY_X, gatewayY, PROVIDER_START_X - 20, py);
              const fill = pulse.success ? 'var(--primary)' : '#f87171';
              return (
                <g key={pulse.id} filter="url(#glow)">
                  <circle r={5} fill={fill} opacity={0.9}>
                    <animateMotion dur="1.4s" fill="freeze" path={pathD} />
                  </circle>
                  <circle r={9} fill={fill} opacity={0.25}>
                    <animateMotion dur="1.4s" fill="freeze" path={pathD} />
                  </circle>
                </g>
              );
            })}

            {/* ── Incoming Traffic node ── */}
            <circle cx={INCOMING_X} cy={incomingY} r={28} fill="hsl(var(--card))" stroke="hsl(var(--border))" strokeWidth={1.5} />
            <text x={INCOMING_X} y={incomingY - 4} textAnchor="middle" className="fill-foreground" fontSize={12} fontWeight={600}>{formatNum(liveRequests)}</text>
            <text x={INCOMING_X} y={incomingY + 10} textAnchor="middle" className="fill-muted-foreground" fontSize={9}>requests</text>

            {/* ── AI Gateway node ── */}
            <circle cx={GATEWAY_X} cy={gatewayY} r={36} fill="hsl(var(--card))" stroke="var(--primary)" strokeWidth={2} />
            <image x={GATEWAY_X - 12} y={gatewayY - 16} width={24} height={24} href="/logo.png" />
            <text x={GATEWAY_X} y={gatewayY + 28} textAnchor="middle" className="fill-muted-foreground" fontSize={9}>AI Gateway</text>
            <text x={GATEWAY_X} y={gatewayY + 38} textAnchor="middle" className="fill-emerald-500" fontSize={10} fontWeight={600}>{(successRate * 100).toFixed(1)}%</text>

            {/* ── Provider nodes ── */}
            {providers.map((p, idx) => {
              const py = 60 + idx * PROVIDER_SPACING;
              const pct = p.requests / totalTraffic;
              const dimmed = !p.enabled || p.requests === 0;
              return (
                <g key={p.id} opacity={dimmed ? 0.4 : 1}>
                  <rect x={PROVIDER_START_X - 20} y={py - 14} width={PROVIDER_COL_W} height={50} rx={8} fill="hsl(var(--card))" stroke="hsl(var(--border))" strokeWidth={1} />
                  <circle cx={PROVIDER_START_X - 6} cy={py + 10} r={4} className={healthColor(p.health)} />
                  {/* Name */}
                  <text x={PROVIDER_START_X + 6} y={py - 2} className="fill-foreground" fontSize={12} fontWeight={500}>{p.name}</text>
                  {/* Stats line */}
                  <text x={PROVIDER_START_X + 6} y={py + 12} className="fill-muted-foreground" fontSize={10}>
                    {p.modelCount} model{p.modelCount !== 1 ? 's' : ''} · {formatNum(p.requests)} req
                  </text>
                  <text x={PROVIDER_START_X + 6} y={py + 25} className="fill-muted-foreground" fontSize={10}>
                    {(pct * 100).toFixed(1)}% traffic · {p.avgLatencyMs < 1000 ? `${Math.round(p.avgLatencyMs)}ms` : `${(p.avgLatencyMs / 1000).toFixed(1)}s`} avg
                    {p.errorRate > 0 && <tspan className="fill-red-500"> · {(p.errorRate * 100).toFixed(0)}% err</tspan>}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
