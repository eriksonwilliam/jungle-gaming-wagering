import { LedgerDirection } from "../../../domain/ledger/ledger-direction";
import { CurrencyMismatchError } from "../../../domain/money/money.errors";
import type { FailureCode } from "../../../domain/wager-transaction/failure-code";
import { WagerTransaction, WagerTransactionKind } from "../../../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../../domain/wallet/wallet";
import { InsufficientBalanceError } from "../../../domain/wallet/wallet.errors";
import { WagerTransactionProcessed } from "../../events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../events/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../events/wallet-balance-changed.event";
import type { Clock } from "../../ports/clock.port";
import type { IdGenerator } from "../../ports/id-generator.port";
import type { LedgerRepository } from "../../ports/ledger-repository.port";
import type { OutboxRepository } from "../../ports/outbox-repository.port";
import type { WagerTransactionRepository } from "../../ports/wager-transaction-repository.port";
import type { WalletRepository } from "../../ports/wallet-repository.port";
import type { EventContextBase } from "./event-context-base";
import { enqueueEvent } from "./enqueue-event";

export interface ApplyEffectsDeps {
  walletRepository: WalletRepository;
  wagerTransactionRepository: WagerTransactionRepository;
  ledgerRepository: LedgerRepository;
  outboxRepository: OutboxRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}

export interface ApplyEffectsResult {
  transaction: WagerTransaction;
  wallet?: Wallet;
}

/**
 * Aplica uma `WagerTransaction` cuja referência (quando exigida) já foi
 * resolvida e validada — compartilhado por `SubmitWagerTransaction` (fluxo
 * síncrono) e `ProcessPendingReferences` (worker de reprocessamento), para
 * que as duas entradas apliquem exatamente a mesma regra. Deve ser chamado
 * dentro de `UnitOfWork.run`.
 */
export async function applyResolvedTransaction(
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  ctxBase: EventContextBase,
  deps: ApplyEffectsDeps,
): Promise<ApplyEffectsResult> {
  const newCtx = () => ({ ...ctxBase, eventId: deps.idGenerator.newId() });

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, deps.clock.now());
    await deps.wagerTransactionRepository.save(transaction);
    await enqueueEvent(deps.outboxRepository, deps.idGenerator, WagerTransactionProcessed.from(transaction, newCtx()));
    return { transaction };
  }

  const wallet = await deps.walletRepository.findByIdForUpdate(transaction.walletId);
  if (!wallet) {
    return rejectAndSave(transaction, "WALLET_NOT_FOUND", ctxBase, deps);
  }

  if (transaction.requiresReference() && reference) {
    const alreadyReversed = await deps.wagerTransactionRepository.existsProcessedReversal(reference.id, transaction.kind);
    if (alreadyReversed) {
      return rejectAndSave(transaction, "REFERENCE_ALREADY_REVERSED", ctxBase, deps);
    }
  }

  const direction = transaction.ledgerDirectionFor(reference);
  const entryId = deps.idGenerator.newId();

  try {
    const entry =
      direction === LedgerDirection.Credit
        ? wallet.credit(transaction.money, transaction.id, entryId, deps.clock.now())
        : wallet.debit(transaction.money, transaction.id, entryId, deps.clock.now());

    transaction.markProcessed(reference?.id, deps.clock.now());

    // Ordem importa: wallet_ledger_entries.transaction_id referencia
    // wager_transactions(id) por FK não adiável — a transação precisa existir
    // na tabela antes do lançamento que a referencia.
    await deps.walletRepository.save(wallet);
    await deps.wagerTransactionRepository.save(transaction);
    await deps.ledgerRepository.save(entry);
    await enqueueEvent(deps.outboxRepository, deps.idGenerator, WalletBalanceChanged.from(wallet, entry, newCtx()));
    await enqueueEvent(deps.outboxRepository, deps.idGenerator, WagerTransactionProcessed.from(transaction, newCtx()));

    return { transaction, wallet };
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      const code: FailureCode =
        transaction.kind === WagerTransactionKind.Bet ? "INSUFFICIENT_BALANCE" : "REVERSAL_INSUFFICIENT_BALANCE";
      return rejectAndSave(transaction, code, ctxBase, deps);
    }
    if (error instanceof CurrencyMismatchError) {
      return rejectAndSave(transaction, "CURRENCY_MISMATCH", ctxBase, deps);
    }
    throw error;
  }
}

async function rejectAndSave(
  transaction: WagerTransaction,
  code: FailureCode,
  ctxBase: EventContextBase,
  deps: ApplyEffectsDeps,
): Promise<ApplyEffectsResult> {
  transaction.reject(code);
  await deps.wagerTransactionRepository.save(transaction);
  await enqueueEvent(
    deps.outboxRepository,
    deps.idGenerator,
    WagerTransactionRejected.from(transaction, code, { ...ctxBase, eventId: deps.idGenerator.newId() }),
  );
  return { transaction };
}
