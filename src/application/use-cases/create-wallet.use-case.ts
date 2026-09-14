import { LedgerDirection } from "../../domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { IntegrationEvent } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import type { EventContext } from "../events/event-context";
import { WagerTransactionProcessed } from "../events/wager-transaction-processed.event";
import { WalletBalanceChanged } from "../events/wallet-balance-changed.event";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { LedgerRepository } from "../ports/ledger-repository.port";
import type { OutboxRepository } from "../ports/outbox-repository.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository.port";
import type { WalletRepository } from "../ports/wallet-repository.port";

const INTERNAL_PROVIDER_ID = "internal";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletResult {
  wallet: Wallet;
}

/**
 * Saldo inicial > 0 gera uma transação OPENING e um lançamento CREDIT na
 * mesma transação SQL da criação da wallet. `WalletRepository.save` deve
 * traduzir a violação da constraint única (playerId, currency) em
 * `WalletAlreadyExistsError` — ver ARCHITECTURE.md.
 */
export class CreateWallet {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly outboxRepository: OutboxRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    const initialBalance = Money.from(input.initialBalance);
    const now = this.clock.now();
    const wallet = Wallet.open({ id: this.idGenerator.newId(), playerId: input.playerId, initialBalance, now });

    return this.unitOfWork.run(async () => {
      await this.walletRepository.save(wallet);

      if (initialBalance.isPositive()) {
        const openingTransaction = WagerTransaction.openingFor({
          id: this.idGenerator.newId(),
          providerId: INTERNAL_PROVIDER_ID,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          at: now,
        });
        const entry = WalletLedgerEntry.create({
          id: this.idGenerator.newId(),
          walletId: wallet.id,
          transactionId: openingTransaction.id,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          createdAt: now,
        });

        await this.wagerTransactionRepository.save(openingTransaction);
        await this.ledgerRepository.save(entry);

        const ctx: EventContext = { eventId: this.idGenerator.newId(), correlationId: input.correlationId, occurredAt: now };
        await this.enqueue(WagerTransactionProcessed.from(openingTransaction, ctx));
        await this.enqueue(WalletBalanceChanged.from(wallet, entry, { ...ctx, eventId: this.idGenerator.newId() }));
      }

      return { wallet };
    });
  }

  private async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    await this.outboxRepository.save(OutboxMessage.enqueue(this.idGenerator.newId(), event));
  }
}
