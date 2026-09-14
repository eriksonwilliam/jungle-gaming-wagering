import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../../application/ports/event-publisher.port";
import { ServiceUnavailableError } from "../../../application/errors/service-unavailable.error";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";

/**
 * Publica no `wagering-events.fifo`, com `MessageGroupId = aggregateId`
 * (garante ordem por wallet dentro do FIFO) e `MessageDeduplicationId =
 * outbox message id` (dedup nativa do SQS como camada extra — o consumidor
 * final ainda é responsável pela própria idempotência).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
        }),
      );
    } catch (error) {
      throw new ServiceUnavailableError("falha ao publicar no SQS", error);
    }
  }
}
