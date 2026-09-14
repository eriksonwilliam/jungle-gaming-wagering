import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/domain/money/money";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import { ProcessPendingReferences } from "../../../../src/application/use-cases/process-pending-references.use-case";
import {
  FakeClock,
  FakeIdGenerator,
  InMemoryLedgerRepository,
  InMemoryOutboxRepository,
  InMemoryWagerTransactionRepository,
  InMemoryWalletRepository,
  PassthroughUnitOfWork,
} from "../support/fakes";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function buildSut() {
  const walletRepository = new InMemoryWalletRepository();
  const wagerTransactionRepository = new InMemoryWagerTransactionRepository();
  const ledgerRepository = new InMemoryLedgerRepository();
  const outboxRepository = new InMemoryOutboxRepository();
  const clock = new FakeClock(NOW);
  const useCase = new ProcessPendingReferences(
    walletRepository,
    wagerTransactionRepository,
    ledgerRepository,
    outboxRepository,
    new PassthroughUnitOfWork(),
    clock,
    new FakeIdGenerator(),
  );
  return { walletRepository, wagerTransactionRepository, ledgerRepository, outboxRepository, clock, useCase };
}

function pendingRefund(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  const tx = WagerTransaction.create({
    id: "refund-1",
    providerId: "provider-a",
    externalTransactionId: "refund-1",
    idempotencyKey: "provider-a:refund-1",
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Refund,
    money: Money.from({ amount: "30.00", currency: "BRL" }),
    referenceExternalTransactionId: "bet-1",
    createdAt: NOW,
    ...overrides,
  });
  tx.markPendingReference();
  return tx;
}

function seedWallet(walletRepository: InMemoryWalletRepository, balance = "100.00"): Wallet {
  const wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: Money.from({ amount: balance, currency: "BRL" }), now: NOW });
  walletRepository.seed(wallet);
  return wallet;
}

describe("ProcessPendingReferences", () => {
  it("não faz nada quando não há transações devidas", async () => {
    const { useCase } = buildSut();
    const result = await useCase.execute();
    expect(result.processed).toBe(0);
  });

  it("agenda novo retry quando a referência ainda não chegou e o limite não foi esgotado", async () => {
    const { useCase, wagerTransactionRepository } = buildSut();
    const tx = pendingRefund();
    wagerTransactionRepository.seed(tx);

    const result = await useCase.execute();

    expect(result.processed).toBe(1);
    const stored = await wagerTransactionRepository.findById(tx.id);
    expect(stored!.status).toBe(WagerTransactionStatus.PendingReference);
    expect(stored!.referenceAttempts).toBe(1);
  });

  it("rejeita com REFERENCE_NOT_FOUND quando esgota as tentativas", async () => {
    const { useCase, wagerTransactionRepository, outboxRepository, clock } = buildSut();
    const tx = pendingRefund();
    for (let i = 0; i < 8; i += 1) {
      tx.scheduleReferenceRetry(NOW);
    }
    wagerTransactionRepository.seed(tx);
    clock.advance(5 * 60 * 60_000); // além do nextAttemptAt agendado, para que o retry fique devido

    await useCase.execute();

    const stored = await wagerTransactionRepository.findById(tx.id);
    expect(stored!.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored!.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(outboxRepository.messages.some((m) => m.eventType === "WagerTransactionRejected")).toBe(true);
  });

  it("rejeita com o failureCode de validate-reference quando a referência resolvida não bate", async () => {
    const { useCase, wagerTransactionRepository } = buildSut();
    const badReference = WagerTransaction.create({
      id: "bet-1",
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      payloadHash: "hash",
      walletId: "wallet-1",
      playerId: "outro-player",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      createdAt: NOW,
    });
    badReference.markProcessed(undefined, NOW);
    wagerTransactionRepository.seed(badReference);
    const tx = pendingRefund();
    wagerTransactionRepository.seed(tx);

    await useCase.execute();

    const stored = await wagerTransactionRepository.findById(tx.id);
    expect(stored!.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored!.failureCode).toBe("REFERENCE_MISMATCH");
  });

  it("processa a reversão quando a referência já chegou e é válida", async () => {
    const { useCase, wagerTransactionRepository, walletRepository } = buildSut();
    seedWallet(walletRepository, "70.00"); // saldo já reflete a BET de 30 que o REFUND vai reverter
    const bet = WagerTransaction.create({
      id: "bet-1",
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      payloadHash: "hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      createdAt: NOW,
    });
    bet.markProcessed(undefined, NOW);
    wagerTransactionRepository.seed(bet);
    const tx = pendingRefund();
    wagerTransactionRepository.seed(tx);

    const result = await useCase.execute();

    expect(result.processed).toBe(1);
    const stored = await wagerTransactionRepository.findById(tx.id);
    expect(stored!.status).toBe(WagerTransactionStatus.Processed);
    const wallet = await walletRepository.findById("wallet-1");
    expect(wallet!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("respeita o batchSize informado", async () => {
    const { useCase, wagerTransactionRepository } = buildSut();
    wagerTransactionRepository.seed(pendingRefund({ id: "r1", externalTransactionId: "r1", idempotencyKey: "provider-a:r1" }));
    wagerTransactionRepository.seed(pendingRefund({ id: "r2", externalTransactionId: "r2", idempotencyKey: "provider-a:r2" }));

    const result = await useCase.execute(1);

    expect(result.processed).toBe(1);
  });
});
