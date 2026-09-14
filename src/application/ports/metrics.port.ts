/** Métricas mínimas exigidas: status de transações, duplicatas, retries, DLQ, locks, outbox lag, latência. */
export interface Metrics {
  incrementCounter(name: string, labels?: Record<string, string>): void;
  observeHistogram(name: string, valueMs: number, labels?: Record<string, string>): void;
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
}
