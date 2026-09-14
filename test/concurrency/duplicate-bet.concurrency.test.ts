import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";
import { buildDependencies, type TestDependencies } from "../integration/support/build-dependencies";
import { startTestDatabase, type TestDatabase } from "../integration/support/test-database";

let db: TestDatabase;
let deps: TestDependencies;

beforeAll(async () => {
  db = await startTestDatabase();
  deps = buildDependencies(db.orm);
}, 60_000);

afterAll(async () => {
  await db.stop();
});

describe("Concorrência — idempotência sob duplicação real", () => {
  it("a mesma aposta enviada 50 vezes em paralelo produz um único débito", async () => {
    const playerId = randomUUID();
    const { wallet } = await deps.run(() =>
      deps.createWallet.execute({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" }, correlationId: "setup" }),
    );

    const input = {
      providerId: "provider-a",
      externalTransactionId: "bet-duplicated",
      idempotencyKey: "provider-a:bet-duplicated",
      payloadHash: "hash-fixed",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
      correlationId: "corr-duplicated",
    } as const;

    const attempts = Array.from({ length: 50 }, () => deps.run(() => deps.submitWagerTransaction.execute(input)));
    const results = await Promise.all(attempts);

    const processedIds = new Set(results.map((r) => r.transaction.id));
    expect(processedIds.size).toBe(1);
    expect(results.every((r) => r.transaction.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);

    const finalWallet = await deps.run(() => deps.walletRepository.findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "975.00", currency: "BRL" });

    // 2 lançamentos no total: CREDIT de abertura (saldo inicial 1000) + um
    // único DEBIT da aposta — nunca dois débitos, mesmo com 50 tentativas.
    const ledgerPage = await deps.run(() => deps.ledgerRepository.findByWallet(wallet.id, undefined, 100));
    expect(ledgerPage.entries).toHaveLength(2);
    expect(ledgerPage.entries.filter((entry) => entry.direction === "DEBIT")).toHaveLength(1);
  });
});
