import { LockMode, type EntityManager } from "@mikro-orm/postgresql";
import type { WalletRepository } from "../../../../application/ports/wallet-repository.port";
import { WalletAlreadyExistsError } from "../../../../application/errors/wallet-already-exists.error";
import { Money } from "../../../../domain/money/money";
import { Wallet } from "../../../../domain/wallet/wallet";
import { WalletEntity } from "../entities/wallet.entity";
import { isUniqueViolation } from "../postgres-error";

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity ? toDomain(entity) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return entity ? toDomain(entity) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(WalletEntity, { playerId, currency });
    return entity ? toDomain(entity) : undefined;
  }

  async save(wallet: Wallet): Promise<void> {
    let entity = await this.em.findOne(WalletEntity, { id: wallet.id });
    if (!entity) {
      entity = new WalletEntity();
      entity.id = wallet.id;
      entity.playerId = wallet.playerId;
      entity.currency = wallet.currency;
      entity.createdAt = wallet.createdAt;
      this.em.persist(entity);
    }
    entity.balanceMinorUnits = wallet.balance.toMinorUnits().toString();
    entity.version = wallet.version;
    entity.updatedAt = wallet.updatedAt;

    try {
      await this.em.flush();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }
}

function toDomain(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: Money.fromMinorUnits(BigInt(entity.balanceMinorUnits), entity.currency),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}
