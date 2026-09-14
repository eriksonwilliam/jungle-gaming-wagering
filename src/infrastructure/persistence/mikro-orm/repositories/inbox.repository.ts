import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository } from "../../../../application/ports/inbox-repository.port";
import { InboxMessage } from "../../../../domain/messaging/inbox-message";
import { InboxMessageEntity } from "../entities/inbox-message.entity";

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async findByConsumerAndMessageId(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const entity = await this.em.findOne(InboxMessageEntity, { consumerName, messageId });
    return entity ? toDomain(entity) : undefined;
  }

  async save(message: InboxMessage): Promise<void> {
    let entity = await this.em.findOne(InboxMessageEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    if (!entity) {
      entity = new InboxMessageEntity();
      entity.consumerName = message.consumerName;
      entity.messageId = message.messageId;
      entity.payloadHash = message.payloadHash;
      entity.receivedAt = message.receivedAt;
      this.em.persist(entity);
    }
    entity.processedAt = message.processedAt;
    await this.em.flush();
  }
}

function toDomain(entity: InboxMessageEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: entity.messageId,
    consumerName: entity.consumerName,
    payloadHash: entity.payloadHash,
    receivedAt: entity.receivedAt,
    processedAt: entity.processedAt,
  });
}
