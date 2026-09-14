import type { Clock } from "../ports/clock.port";
import type { EventPublisher } from "../ports/event-publisher.port";
import type { Logger } from "../ports/logger.port";
import type { OutboxRepository } from "../ports/outbox-repository.port";

const DEFAULT_BATCH_SIZE = 50;

export interface PublishOutboxBatchResult {
  published: number;
  failed: number;
}

/**
 * Relay da outbox — pode rodar em múltiplas instâncias ao mesmo tempo.
 * `claimDueBatch` (implementado no adapter com `FOR UPDATE SKIP LOCKED`)
 * garante que publishers concorrentes peguem lotes disjuntos. Uma publicação
 * duplicada é aceitável (SQS já é at-least-once); uma falha reagenda com
 * backoff em vez de derrubar o lote inteiro.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async execute(batchSize: number = DEFAULT_BATCH_SIZE): Promise<PublishOutboxBatchResult> {
    const batch = await this.outboxRepository.claimDueBatch(this.clock.now(), batchSize);
    let published = 0;
    let failed = 0;

    for (const message of batch) {
      try {
        await this.eventPublisher.publish(message);
        message.markPublished(this.clock.now());
        await this.outboxRepository.update(message);
        published += 1;
      } catch (error) {
        message.scheduleRetry(this.clock.now());
        await this.outboxRepository.update(message);
        failed += 1;
        this.logger.warn("outbox_publish_failed", {
          outboxMessageId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { published, failed };
  }
}
