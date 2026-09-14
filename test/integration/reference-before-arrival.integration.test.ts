import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";
import { buildDependencies, type TestDependencies } from "./support/build-dependencies";
import { startTestDatabase, type TestDatabase } from "./support/test-database";

let db: TestDatabase;
let deps: TestDependencies;

beforeAll(async () => {
  db = await startTestDatabase();
  deps = buildDependencies(db.orm);
}, 60_000);

afterAll(async () => {
  await db.stop();
});

describe("REFUND/ROLLBACK entregue antes da referência", () => {
  it("REFUND antes da BET fica PENDING_REFERENCE e é processado assim que a BET chega", async () => {
    const playerId = randomUUID();
    const { wallet } = await deps.run(() =>
      deps.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }),
    );

    const refundResult = await deps.run(() =>
      deps.submitWagerTransaction.execute({
        providerId: "provider-a",
        externalTransactionId: "refund-1",
        idempotencyKey: "provider-a:refund-1",
        payloadHash: "hash-refund",
        playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: { amount: "30.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
        correlationId: "corr-refund",
      }),
    );
    expect(refundResult.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    const betResult = await deps.run(() =>
      deps.submitWagerTransaction.execute({
        providerId: "provider-a",
        externalTransactionId: "bet-1",
        idempotencyKey: "provider-a:bet-1",
        payloadHash: "hash-bet",
        playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
        correlationId: "corr-bet",
      }),
    );
    expect(betResult.transaction.status).toBe(WagerTransactionStatus.Processed);

    await deps.run(() => deps.processPendingReferences.execute());

    const reprocessed = await deps.run(() => deps.wagerTransactionRepository.findById(refundResult.transaction.id));
    expect(reprocessed!.status).toBe(WagerTransactionStatus.Processed);

    const finalWallet = await deps.run(() => deps.walletRepository.findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("REFUND cuja referência nunca chega é rejeitado após esgotar as tentativas", async () => {
    const playerId = randomUUID();
    const { wallet } = await deps.run(() =>
      deps.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }),
    );

    const refundResult = await deps.run(() =>
      deps.submitWagerTransaction.execute({
        providerId: "provider-a",
        externalTransactionId: "refund-orfao",
        idempotencyKey: "provider-a:refund-orfao",
        payloadHash: "hash-refund-orfao",
        playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-nunca-chega",
        correlationId: "corr-refund-orfao",
      }),
    );
    expect(refundResult.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    // esgota as tentativas manualmente, forçando o próximo retry a estar sempre devido
    const tx = (await deps.run(() => deps.wagerTransactionRepository.findById(refundResult.transaction.id)))!;
    for (let i = 0; i < 8; i += 1) {
      tx.scheduleReferenceRetry(new Date(0));
    }
    await deps.run(() => deps.wagerTransactionRepository.save(tx));

    await deps.run(() => deps.processPendingReferences.execute());

    const finalTx = await deps.run(() => deps.wagerTransactionRepository.findById(refundResult.transaction.id));
    expect(finalTx!.status).toBe(WagerTransactionStatus.Rejected);
    expect(finalTx!.failureCode).toBe("REFERENCE_NOT_FOUND");
  });
});
