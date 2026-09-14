import type { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { WagerTransactionRejected } from "../events/wager-transaction-rejected.event";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { LedgerRepository } from "../ports/ledger-repository.port";
import type { OutboxRepository } from "../ports/outbox-repository.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository.port";
import type { WalletRepository } from "../ports/wallet-repository.port";
import { applyResolvedTransaction } from "./support/apply-transaction-effects";
import { enqueueEvent } from "./support/enqueue-event";
import type { EventContextBase } from "./support/event-context-base";
import { validateReferenceMatch } from "./support/validate-reference";

const DEFAULT_BATCH_SIZE = 50;

export interface ProcessPendingReferencesResult {
  processed: number;
}

/**
 * Worker agendado: reprocessa REFUND/ROLLBACK que ficaram PENDING_REFERENCE.
 * Cada transação é tentada em sua própria `UnitOfWork` — uma falha em uma não
 * derruba o lote inteiro. Backoff e limite de tentativas vivem no próprio
 * agregado (`WagerTransaction.scheduleReferenceRetry` /
 * `hasExhaustedReferenceRetries`) — ver ARCHITECTURE.md §7.
 */
export class ProcessPendingReferences {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly outboxRepository: OutboxRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(batchSize: number = DEFAULT_BATCH_SIZE): Promise<ProcessPendingReferencesResult> {
    const due = await this.wagerTransactionRepository.findDuePendingReference(this.clock.now(), batchSize);
    for (const transaction of due) {
      await this.unitOfWork.run(() => this.retryOne(transaction));
    }
    return { processed: due.length };
  }

  private async retryOne(transaction: WagerTransaction): Promise<void> {
    const now = this.clock.now();
    const ctxBase: EventContextBase = { correlationId: transaction.id, occurredAt: now };

    const reference = await this.wagerTransactionRepository.findByProviderAndExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId as string,
    );

    if (!reference) {
      if (transaction.hasExhaustedReferenceRetries()) {
        transaction.reject("REFERENCE_NOT_FOUND");
        await this.wagerTransactionRepository.save(transaction);
        await enqueueEvent(
          this.outboxRepository,
          this.idGenerator,
          WagerTransactionRejected.from(transaction, "REFERENCE_NOT_FOUND", { ...ctxBase, eventId: this.idGenerator.newId() }),
        );
        return;
      }
      transaction.scheduleReferenceRetry(now);
      await this.wagerTransactionRepository.save(transaction);
      return;
    }

    const mismatch = validateReferenceMatch(transaction, reference);
    if (mismatch) {
      transaction.reject(mismatch);
      await this.wagerTransactionRepository.save(transaction);
      await enqueueEvent(
        this.outboxRepository,
        this.idGenerator,
        WagerTransactionRejected.from(transaction, mismatch, { ...ctxBase, eventId: this.idGenerator.newId() }),
      );
      return;
    }

    await applyResolvedTransaction(transaction, reference, ctxBase, {
      walletRepository: this.walletRepository,
      wagerTransactionRepository: this.wagerTransactionRepository,
      ledgerRepository: this.ledgerRepository,
      outboxRepository: this.outboxRepository,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
  }
}
