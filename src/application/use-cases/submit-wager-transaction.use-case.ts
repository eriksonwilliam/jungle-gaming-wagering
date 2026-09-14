import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import { IdempotencyConflictError } from "../errors/idempotency-conflict.error";
import { IdempotencyRaceLostError } from "../errors/idempotency-race-lost.error";
import { WagerTransactionPendingReference } from "../events/wager-transaction-pending-reference.event";
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

export interface SubmitWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
}

export interface SubmitWagerTransactionResult {
  transaction: WagerTransaction;
  wallet?: Wallet;
  idempotentReplay: boolean;
}

/**
 * Reusada pela entrada HTTP e pelo consumidor SQS — ambas chamam `execute`
 * com o mesmo input, garantindo que idempotência, concorrência e consistência
 * valham para os dois canais igualmente.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly outboxRepository: OutboxRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(input: SubmitWagerTransactionInput): Promise<SubmitWagerTransactionResult> {
    const existing = await this.wagerTransactionRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return this.buildReplay(existing, input);
    }

    const transaction = WagerTransaction.create({
      id: this.idGenerator.newId(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: Money.from(input.money),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });

    try {
      const result = await this.unitOfWork.run(() => this.process(transaction, input));
      return { ...result, idempotentReplay: false };
    } catch (error) {
      if (error instanceof IdempotencyRaceLostError) {
        // Duas requisições com a mesma Idempotency-Key correram em paralelo;
        // a checagem inicial não viu nada nas duas, e o INSERT desta perdeu
        // para a constraint única do banco. A vencedora já commitou (é por
        // isso que a constraint disparou) — busca e devolve o resultado dela.
        const winner = await this.wagerTransactionRepository.findByIdempotencyKey(input.idempotencyKey);
        if (winner) {
          return this.buildReplay(winner, input);
        }
      }
      throw error;
    }
  }

  private async buildReplay(
    existing: WagerTransaction,
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionResult> {
    if (!existing.matchesPayload(input.payloadHash)) {
      throw new IdempotencyConflictError(input.idempotencyKey);
    }
    const wallet = existing.affectsBalance() ? await this.walletRepository.findById(existing.walletId) : undefined;
    return { transaction: existing, wallet, idempotentReplay: true };
  }

  private async process(
    transaction: WagerTransaction,
    input: SubmitWagerTransactionInput,
  ): Promise<{ transaction: WagerTransaction; wallet?: Wallet }> {
    const ctxBase: EventContextBase = {
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: this.clock.now(),
    };

    let reference: WagerTransaction | undefined;
    if (transaction.requiresReference()) {
      reference = await this.wagerTransactionRepository.findByProviderAndExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId as string,
      );
      if (!reference) {
        transaction.markPendingReference();
        await this.wagerTransactionRepository.save(transaction);
        await enqueueEvent(
          this.outboxRepository,
          this.idGenerator,
          WagerTransactionPendingReference.from(transaction, { ...ctxBase, eventId: this.idGenerator.newId() }),
        );
        return { transaction };
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
        return { transaction };
      }
    } else if (transaction.kind === WagerTransactionKind.Win && input.referenceExternalTransactionId) {
      // WIN pode referenciar a BET da mesma rodada — link opcional, best-effort, não bloqueia o processamento.
      reference = await this.wagerTransactionRepository.findByProviderAndExternalId(
        transaction.providerId,
        input.referenceExternalTransactionId,
      );
    }

    return applyResolvedTransaction(transaction, reference, ctxBase, {
      walletRepository: this.walletRepository,
      wagerTransactionRepository: this.wagerTransactionRepository,
      ledgerRepository: this.ledgerRepository,
      outboxRepository: this.outboxRepository,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
  }
}
