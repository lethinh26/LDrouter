// Prometheus-style metrics registry. Lightweight, no external dep.

import type { Logger } from 'pino';

export interface Counter {
  inc(labels?: Record<string, string>, n?: number): void;
  value(labels?: Record<string, string>): number;
}

export interface Histogram {
  observe(valueMs: number, labels?: Record<string, string>): void;
  snapshot(): { buckets: Array<{ le: number; count: number }>; count: number; sum: number; labels: string[] };
}

export interface Gauge {
  set(v: number, labels?: Record<string, string>): void;
  inc(labels?: Record<string, string>, n?: number): void;
  dec(labels?: Record<string, string>, n?: number): void;
}

interface CounterSeries { labels: Record<string, string>; value: number }
interface HistogramSeries {
  labels: Record<string, string>;
  buckets: number[]; // bucket upper bounds in ms
  counts: number[];
  count: number;
  sum: number;
}
interface GaugeSeries { labels: Record<string, string>; value: number }

class CounterImpl implements Counter {
  private series: CounterSeries[] = [];
  constructor(private name: string, private help: string) {}
  inc(labels: Record<string, string> = {}, n = 1) {
    const found = this.series.find((s) => sameLabels(s.labels, labels));
    if (found) found.value += n;
    else this.series.push({ labels, value: n });
    registryMetrics.push(this);
  }
  value(labels: Record<string, string> = {}) {
    const found = this.series.find((s) => sameLabels(s.labels, labels));
    return found?.value ?? 0;
  }
  render() {
    if (this.series.length === 0) return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.series
      .map((s) => `${this.name}${labelString(s.labels)} ${s.value}`)
      .join('\n')}\n`;
  }
}

const DEFAULT_BUCKETS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000];

class HistogramImpl implements Histogram {
  private series: HistogramSeries[] = [];
  constructor(private name: string, private help: string, private buckets: number[]) {}
  observe(valueMs: number, labels: Record<string, string> = {}) {
    let s = this.series.find((x) => sameLabels(x.labels, labels));
    if (!s) {
      s = { labels, buckets: [...this.buckets], counts: new Array(this.buckets.length).fill(0), count: 0, sum: 0 };
      this.series.push(s);
    }
    s.count += 1;
    s.sum += valueMs;
    for (let i = 0; i < this.buckets.length; i++) {
      if (valueMs <= this.buckets[i]!) s.counts[i]! += 1;
    }
    registryMetrics.push(this);
  }
  snapshot() {
    return this.series.map((s) => ({
      buckets: s.buckets.map((le, i) => ({ le, count: s.counts[i]! })),
      count: s.count,
      sum: s.sum,
      labels: Object.keys(s.labels),
    }))[0] ?? { buckets: [], count: 0, sum: 0, labels: [] };
  }
  render() {
    if (this.series.length === 0) return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    for (const s of this.series) {
      for (let i = 0; i < s.buckets.length; i++) {
        const count = s.counts[i]!;
        out += `${this.name}_bucket{${labelString({ ...s.labels, le: String(s.buckets[i]!) }, true)} ${count}\n`;
      }
      out += `${this.name}_bucket{${labelString({ ...s.labels, le: '+Inf' }, true)} ${s.count}\n`;
      out += `${this.name}_count${labelString(s.labels)} ${s.count}\n`;
      out += `${this.name}_sum${labelString(s.labels)} ${s.sum}\n`;
    }
    return out;
  }
}

class GaugeImpl implements Gauge {
  private series: GaugeSeries[] = [];
  constructor(private name: string, private help: string) {}
  set(v: number, labels: Record<string, string> = {}) {
    const f = this.series.find((s) => sameLabels(s.labels, labels));
    if (f) f.value = v;
    else this.series.push({ labels, value: v });
    registryMetrics.push(this);
  }
  inc(labels: Record<string, string> = {}, n = 1) { this.set(this.value(labels) + n, labels); }
  dec(labels: Record<string, string> = {}, n = 1) { this.set(this.value(labels) - n, labels); }
  value(labels: Record<string, string> = {}) { return this.series.find((s) => sameLabels(s.labels, labels))?.value ?? 0; }
  render() {
    if (this.series.length === 0) return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.series
      .map((s) => `${this.name}${labelString(s.labels)} ${s.value}`)
      .join('\n')}\n`;
  }
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function labelString(labels: Record<string, string>, skipEmpty = false): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const filtered = skipEmpty ? keys.filter((k) => labels[k] !== undefined) : keys;
  if (filtered.length === 0) return '';
  return `{${filtered.map((k) => `${k}="${(labels[k] ?? '').replace(/"/g, '\\"')}"`).join(',')}}`;
}

const registryMetrics: Array<CounterImpl | HistogramImpl | GaugeImpl> = [];

export const metricsRegistry = {
  _logger: null as Logger | null,
  init(logger: Logger) {
    this._logger = logger;
  },
  counter(name: string, help: string): Counter {
    return new CounterImpl(name, help);
  },
  histogram(name: string, help: string, bucketsMs: number[] = DEFAULT_BUCKETS_MS): Histogram {
    return new HistogramImpl(name, help, bucketsMs);
  },
  gauge(name: string, help: string): Gauge {
    return new GaugeImpl(name, help);
  },
  render(): string {
    const seen = new Set<unknown>();
    let out = '';
    for (const m of registryMetrics) {
      if (seen.has(m)) continue;
      seen.add(m);
      out += (m as { render: () => string }).render();
    }
    return out;
  },
};

// Predefined metrics used across the app
export const metrics = {
  requestsTotal: metricsRegistry.counter('latedev_requests_total', 'Total gateway requests by protocol and status class'),
  requestDuration: metricsRegistry.histogram('latedev_request_duration_ms', 'Gateway request duration in ms'),
  requestTtft: metricsRegistry.histogram('latedev_request_ttft_ms', 'Time to first token in ms'),
  attemptsTotal: metricsRegistry.counter('latedev_upstream_attempts_total', 'Upstream attempts by provider and result'),
  attemptDuration: metricsRegistry.histogram('latedev_upstream_attempt_duration_ms', 'Upstream attempt duration in ms'),
  tokensInput: metricsRegistry.counter('latedev_tokens_input_total', 'Input tokens processed'),
  tokensOutput: metricsRegistry.counter('latedev_tokens_output_total', 'Output tokens processed'),
  tokensCacheRead: metricsRegistry.counter('latedev_tokens_cache_read_total', 'Provider cache read tokens'),
  tokensCacheWrite: metricsRegistry.counter('latedev_tokens_cache_write_total', 'Provider cache write tokens'),
  tokensReasoning: metricsRegistry.counter('latedev_tokens_reasoning_total', 'Reasoning tokens processed'),
  fallbackCount: metricsRegistry.counter('latedev_fallback_total', 'Number of fallback transitions'),
  activeRequests: metricsRegistry.gauge('latedev_active_requests', 'Number of in-flight gateway requests'),
  circuitState: metricsRegistry.gauge('latedev_provider_circuit_state', 'Provider circuit state (0=closed, 1=open)'),
  rateLimited: metricsRegistry.counter('latedev_rate_limited_total', 'Number of rate-limit denials'),
  cacheHits: metricsRegistry.counter('latedev_gateway_cache_hits_total', 'Gateway response cache hits'),
};
