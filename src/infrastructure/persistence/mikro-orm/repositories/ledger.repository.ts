import type { EntityManager } from "@mikro-orm/postgresql";
import { QueryOrder } from "@mikro-orm/core";
import type { LedgerPage, LedgerReconciliation, LedgerRepository } from "../../../../application/ports/ledger-repository.port";
import { LedgerDirection } from "../../../../domain/ledger/ledger-direction";
import { Money } from "../../../../domain/money/money";
import { WalletLedgerEntry } from "../../../../domain/ledger/wallet-ledger-entry";
import { WalletLedgerEntryEntity } from "../entities/wallet-ledger-entry.entity";

const DEFAULT_CURSOR_LIMIT = 50;

/** Cursor opaco e estável: id do último lançamento lido (created_at, id) — ver `findByWallet`. */
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amountMinorUnits = entry.money.toMinorUnits().toString();
    entity.currency = entry.money.currency;
    entity.balanceBeforeMinorUnits = entry.balanceBefore.toMinorUnits().toString();
    entity.balanceAfterMinorUnits = entry.balanceAfter.toMinorUnits().toString();
    entity.createdAt = entry.createdAt;
    this.em.persist(entity);
    await this.em.flush();
  }

  async findByWallet(walletId: string, cursor: string | undefined, limit: number = DEFAULT_CURSOR_LIMIT): Promise<LedgerPage> {
    const cursorEntity = cursor ? await this.em.findOne(WalletLedgerEntryEntity, { id: cursor }) : undefined;
    const where: Record<string, unknown> = { walletId };
    if (cursorEntity) {
      where["createdAt"] = { $lte: cursorEntity.createdAt };
    }

    const entities = await this.em.find(WalletLedgerEntryEntity, where, {
      orderBy: [{ createdAt: QueryOrder.DESC }, { id: QueryOrder.DESC }],
      limit: limit + 1,
      offset: cursorEntity ? 1 : 0,
    });

    const hasMore = entities.length > limit;
    const page = hasMore ? entities.slice(0, limit) : entities;
    return {
      entries: page.map(toDomain),
      nextCursor: hasMore ? page[page.length - 1]?.id : undefined,
    };
  }

  async reconcile(walletId: string): Promise<LedgerReconciliation> {
    const entities = await this.em.find(WalletLedgerEntryEntity, { walletId }, { orderBy: { createdAt: QueryOrder.ASC } });
    if (entities.length === 0) {
      return { calculatedBalance: Money.zero("BRL"), checkedEntries: 0 };
    }
    let balance = Money.zero(entities[0]!.currency);
    for (const entity of entities) {
      const money = Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currency);
      balance = entity.direction === LedgerDirection.Credit ? balance.add(money) : balance.subtract(money);
    }
    return { calculatedBalance: balance, checkedEntries: entities.length };
  }
}

function toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: entity.id,
    walletId: entity.walletId,
    transactionId: entity.transactionId,
    direction: entity.direction,
    money: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currency),
    balanceBefore: Money.fromMinorUnits(BigInt(entity.balanceBeforeMinorUnits), entity.currency),
    balanceAfter: Money.fromMinorUnits(BigInt(entity.balanceAfterMinorUnits), entity.currency),
    createdAt: entity.createdAt,
  });
}
