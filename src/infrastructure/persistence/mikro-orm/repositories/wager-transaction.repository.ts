import type { EntityManager } from "@mikro-orm/postgresql";
import { QueryOrder } from "@mikro-orm/core";
import type { WagerTransactionRepository } from "../../../../application/ports/wager-transaction-repository.port";
import { IdempotencyRaceLostError } from "../../../../application/errors/idempotency-race-lost.error";
import { Money } from "../../../../domain/money/money";
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionKind,
} from "../../../../domain/wager-transaction/wager-transaction";
import { WagerTransactionEntity } from "../entities/wager-transaction.entity";
import { isUniqueViolation } from "../postgres-error";

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });
    return entity ? toDomain(entity) : undefined;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity ? toDomain(entity) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity ? toDomain(entity) : undefined;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    let entity = await this.em.findOne(WagerTransactionEntity, { id: transaction.id });
    if (!entity) {
      entity = new WagerTransactionEntity();
      entity.id = transaction.id;
      entity.providerId = transaction.providerId;
      entity.externalTransactionId = transaction.externalTransactionId;
      entity.idempotencyKey = transaction.idempotencyKey;
      entity.payloadHash = transaction.payloadHash;
      entity.walletId = transaction.walletId;
      entity.playerId = transaction.playerId;
      entity.roundId = transaction.roundId;
      entity.gameId = transaction.gameId;
      entity.kind = transaction.kind;
      entity.amountMinorUnits = transaction.money.toMinorUnits().toString();
      entity.currency = transaction.money.currency;
      entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
      entity.createdAt = transaction.createdAt;
      this.em.persist(entity);
    }
    entity.status = transaction.status;
    entity.referenceTransactionId = transaction.referenceTransactionId;
    entity.failureCode = transaction.failureCode;
    entity.processedAt = transaction.processedAt;
    entity.referenceAttempts = transaction.referenceAttempts;
    entity.referenceNextAttemptAt = transaction.referenceNextAttemptAt;

    try {
      await this.em.flush();
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Duas requisições com a mesma Idempotency-Key correram em paralelo e
        // ambas tentaram inserir — a constraint única do banco (não um lock
        // de aplicação) é quem de fato serializa isso. Quem perde aqui deve
        // buscar e devolver o resultado de quem venceu, não propagar o erro.
        throw new IdempotencyRaceLostError(transaction.idempotencyKey);
      }
      throw error;
    }
  }

  async findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ referenceNextAttemptAt: null }, { referenceNextAttemptAt: { $lte: now } }],
      },
      { limit, orderBy: { createdAt: QueryOrder.ASC } },
    );
    return entities.map(toDomain);
  }

  async existsProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }
}

function toDomain(entity: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    money: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currency),
    referenceExternalTransactionId: entity.referenceExternalTransactionId,
    createdAt: entity.createdAt,
    status: entity.status,
    referenceTransactionId: entity.referenceTransactionId,
    failureCode: entity.failureCode,
    processedAt: entity.processedAt,
    referenceAttempts: entity.referenceAttempts,
    referenceNextAttemptAt: entity.referenceNextAttemptAt,
  });
}
