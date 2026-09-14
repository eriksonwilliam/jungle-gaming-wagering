import { LockMode, QueryOrder, type EntityManager } from "@mikro-orm/postgresql";
import type { OutboxRepository } from "../../../../application/ports/outbox-repository.port";
import { OutboxMessage } from "../../../../domain/messaging/outbox-message";
import { OutboxMessageEntity } from "../entities/outbox-message.entity";

const DEFAULT_BATCH_LIMIT = 50;
/** Janela de reserva de um lote reivindicado — se o publisher morrer antes de chamar `update`, a linha volta a ficar devida. */
const CLAIM_TIMEOUT_MS = 60_000;

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async save(message: OutboxMessage): Promise<void> {
    const entity = new OutboxMessageEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payload = message.payload as Record<string, unknown>;
    entity.occurredAt = message.occurredAt;
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt;
    entity.publishedAt = message.publishedAt;
    this.em.persist(entity);
    await this.em.flush();
  }

  /**
   * `FOR UPDATE SKIP LOCKED` (via LockMode.PESSIMISTIC_PARTIAL_WRITE) numa
   * transação curta e própria: publishers concorrentes pegam lotes disjuntos
   * sem se bloquear. As linhas reivindicadas ganham um `nextAttemptAt`
   * temporário (janela de reserva) para que, se este processo morrer antes de
   * chamar `update`, outro publisher possa reivindicá-las de novo depois do
   * timeout — sem depender de manter a transação aberta durante a publicação.
   */
  async claimDueBatch(now: Date, limit: number = DEFAULT_BATCH_LIMIT): Promise<OutboxMessage[]> {
    return this.em.transactional(async (trx) => {
      const entities = await trx.find(
        OutboxMessageEntity,
        {
          publishedAt: null,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        { limit, orderBy: { occurredAt: QueryOrder.ASC }, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );

      const claimedUntil = new Date(now.getTime() + CLAIM_TIMEOUT_MS);
      for (const entity of entities) {
        entity.nextAttemptAt = claimedUntil;
      }
      await trx.flush();

      return entities.map(toDomain);
    });
  }

  async update(message: OutboxMessage): Promise<void> {
    const entity = await this.em.findOne(OutboxMessageEntity, { id: message.id });
    if (!entity) {
      return;
    }
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt;
    entity.publishedAt = message.publishedAt;
    await this.em.flush();
  }
}

function toDomain(entity: OutboxMessageEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: entity.id,
    aggregateId: entity.aggregateId,
    eventType: entity.eventType,
    payload: entity.payload,
    occurredAt: entity.occurredAt,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt,
    publishedAt: entity.publishedAt,
  });
}
