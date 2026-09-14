import type { Metrics } from "../../application/ports/metrics.port";

const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface Series<T> {
  labels: Record<string, string>;
  state: T;
}

/**
 * Registro de métricas Prometheus escrito à mão (sem `prom-client`) — o
 * formato de texto exposto é simples o bastante para não justificar a
 * dependência. Exposto em `/metrics` pelo `MetricsController`.
 */
export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<string, Series<{ value: number }>[]>();
  private readonly histograms = new Map<string, Series<{ count: number; sum: number; buckets: Map<number, number> }>[]>();
  private readonly gauges = new Map<string, Series<{ value: number }>[]>();

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    const series = this.findOrCreate(this.counters, name, labels, () => ({ value: 0 }));
    series.state.value += 1;
  }

  observeHistogram(name: string, valueMs: number, labels: Record<string, string> = {}): void {
    const series = this.findOrCreate(this.histograms, name, labels, () => ({
      count: 0,
      sum: 0,
      buckets: new Map(HISTOGRAM_BUCKETS_MS.map((bucket) => [bucket, 0])),
    }));
    series.state.count += 1;
    series.state.sum += valueMs;
    for (const bucket of HISTOGRAM_BUCKETS_MS) {
      if (valueMs <= bucket) {
        series.state.buckets.set(bucket, (series.state.buckets.get(bucket) ?? 0) + 1);
      }
    }
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const series = this.findOrCreate(this.gauges, name, labels, () => ({ value: 0 }));
    series.state.value = value;
  }

  toPrometheusText(): string {
    const lines: string[] = [];
    for (const [name, seriesList] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const series of seriesList) {
        lines.push(`${name}${formatLabels(series.labels)} ${series.state.value}`);
      }
    }
    for (const [name, seriesList] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const series of seriesList) {
        lines.push(`${name}${formatLabels(series.labels)} ${series.state.value}`);
      }
    }
    for (const [name, seriesList] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const series of seriesList) {
        for (const [bucket, count] of series.state.buckets) {
          lines.push(`${name}_bucket${formatLabels({ ...series.labels, le: String(bucket) })} ${count}`);
        }
        lines.push(`${name}_bucket${formatLabels({ ...series.labels, le: "+Inf" })} ${series.state.count}`);
        lines.push(`${name}_sum${formatLabels(series.labels)} ${series.state.sum}`);
        lines.push(`${name}_count${formatLabels(series.labels)} ${series.state.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private findOrCreate<T>(
    registry: Map<string, Series<T>[]>,
    name: string,
    labels: Record<string, string>,
    initial: () => T,
  ): Series<T> {
    const seriesList = registry.get(name) ?? [];
    const existing = seriesList.find((series) => sameLabels(series.labels, labels));
    if (existing) {
      return existing;
    }
    const created: Series<T> = { labels, state: initial() };
    seriesList.push(created);
    registry.set(name, seriesList);
    return created;
  }
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => a[key] === b[key]);
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return "";
  }
  return `{${keys.map((key) => `${key}="${labels[key]}"`).join(",")}}`;
}
