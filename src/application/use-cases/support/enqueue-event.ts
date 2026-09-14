import type { IntegrationEvent } from "../../../domain/messaging/integration-event";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import type { IdGenerator } from "../../ports/id-generator.port";
import type { OutboxRepository } from "../../ports/outbox-repository.port";

export async function enqueueEvent(
  outboxRepository: OutboxRepository,
  idGenerator: IdGenerator,
  event: IntegrationEvent<unknown>,
): Promise<void> {
  await outboxRepository.save(OutboxMessage.enqueue(idGenerator.newId(), event));
}
