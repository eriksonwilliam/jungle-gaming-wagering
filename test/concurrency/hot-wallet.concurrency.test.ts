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

/**
 * Cenário obrigatório da seção 8 do desafio: saldo inicial 100.00, duas
 * apostas de 80.00 processadas simultaneamente contra Postgres real. Exatamente
 * uma PROCESSED, a outra REJECTED por saldo insuficiente, saldo final 20.00,
 * exatamente um lançamento de débito.
 */
describe("Concorrência — hot wallet (paralelismo real, Postgres real)", () => {
  it("exatamente uma de duas apostas de 80 contra saldo de 100 é processada", async () => {
    const playerId = randomUUID();
    const { wallet } = await deps.run(() =>
      deps.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }),
    );

    const submit = (externalId: string) =>
      deps.run(() =>
        deps.submitWagerTransaction.execute({
          providerId: "provider-a",
          externalTransactionId: externalId,
          idempotencyKey: `provider-a:${externalId}`,
          payloadHash: `hash-${externalId}`,
          playerId,
          walletId: wallet.id,
          roundId: "round-1",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "80.00", currency: "BRL" },
          correlationId: `corr-${externalId}`,
        }),
      );

    const [first, second] = await Promise.all([submit("bet-1"), submit("bet-2")]);

    const statuses = [first.transaction.status, second.transaction.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());

    const finalWallet = await deps.run(() => deps.walletRepository.findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "20.00", currency: "BRL" });

    const ledgerPage = await deps.run(() => deps.ledgerRepository.findByWallet(wallet.id, undefined, 100));
    const debits = ledgerPage.entries.filter((entry) => entry.direction === "DEBIT");
    expect(debits).toHaveLength(1);
  });

  it("três apostas concorrentes contra um saldo que só cabe uma processam corretamente sem lost update", async () => {
    const playerId = randomUUID();
    const { wallet } = await deps.run(() =>
      deps.createWallet.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" }, correlationId: "setup" }),
    );

    const submit = (externalId: string) =>
      deps.run(() =>
        deps.submitWagerTransaction.execute({
          providerId: "provider-a",
          externalTransactionId: externalId,
          idempotencyKey: `provider-a:${externalId}`,
          payloadHash: `hash-${externalId}`,
          playerId,
          walletId: wallet.id,
          roundId: "round-1",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "50.00", currency: "BRL" },
          correlationId: `corr-${externalId}`,
        }),
      );

    const results = await Promise.all([submit("a"), submit("b"), submit("c")]);
    const processedCount = results.filter((r) => r.transaction.status === WagerTransactionStatus.Processed).length;
    const rejectedCount = results.filter((r) => r.transaction.status === WagerTransactionStatus.Rejected).length;

    expect(processedCount).toBe(1);
    expect(rejectedCount).toBe(2);

    const finalWallet = await deps.run(() => deps.walletRepository.findById(wallet.id));
    expect(finalWallet!.balance.isZero()).toBe(true);
  });
});
