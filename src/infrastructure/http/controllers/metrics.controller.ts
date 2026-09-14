import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public } from "../../identity/public.decorator";
import { PrometheusMetrics } from "../../observability/prometheus-metrics.adapter";
import { METRICS } from "../../tokens";

@ApiExcludeController()
@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  get(): string {
    return this.metrics.toPrometheusText();
  }
}
