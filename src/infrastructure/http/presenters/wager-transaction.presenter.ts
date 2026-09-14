import type { WagerTransaction } from "../../../domain/wager-transaction/wager-transaction";

export function presentWagerTransaction(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    processedAt: transaction.processedAt?.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
  };
}
