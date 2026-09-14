import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Metrics } from "../../application/ports/metrics.port";

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * O app nunca vê uma mensagem sendo movida para a DLQ — é o broker que faz
 * isso, sem notificar o consumidor. A única forma honesta de observar
 * profundidade de DLQ é perguntar à fila periodicamente, por fora do fluxo
 * de consumo. Poll simples via setInterval, mesmo padrão do
 * `OutboxPublisherScheduler`.
 */
export class DlqDepthScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly client: SQSClient,
    private readonly dlqUrl: string,
    private readonly metrics: Metrics,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const response = await this.client.send(
        new GetQueueAttributesCommand({ QueueUrl: this.dlqUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
      );
      const depth = Number(response.Attributes?.ApproximateNumberOfMessages ?? 0);
      this.metrics.setGauge("wager_transactions_dlq_depth", depth);
    } finally {
      this.running = false;
    }
  }
}
