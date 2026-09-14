import type { FailureCode } from "../../../domain/wager-transaction/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction/wager-transaction";

const ALLOWED_REFERENCE_KIND: Readonly<Record<string, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

/**
 * Valida estrutura e compatibilidade da referência já resolvida (mesmo
 * provider/player/wallet/round/moeda, status PROCESSED, kind compatível,
 * valor igual). Não valida reversão duplicada — isso exige o lock da wallet
 * (ver `WagerTransactionRepository.existsProcessedReversal`, chamado depois
 * de adquirir o lock).
 */
export function validateReferenceMatch(transaction: WagerTransaction, reference: WagerTransaction): FailureCode | undefined {
  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.roundId !== transaction.roundId
  ) {
    return "REFERENCE_MISMATCH";
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return "REFERENCE_MISMATCH";
  }
  const allowedKinds = ALLOWED_REFERENCE_KIND[transaction.kind];
  if (!allowedKinds?.has(reference.kind)) {
    return "REFERENCE_MISMATCH";
  }
  if (!reference.money.equals(transaction.money)) {
    return "REFERENCE_MISMATCH";
  }
  return undefined;
}
