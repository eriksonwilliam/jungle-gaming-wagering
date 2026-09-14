import { describe, expect, it } from "bun:test";
import { WagerTransactionStatus } from "../../../../src/domain/wager-transaction/wager-transaction";
import { CreateWallet } from "../../../../src/application/use-cases/create-wallet.use-case";
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
  const useCase = new CreateWallet(
    walletRepository,
    wagerTransactionRepository,
    ledgerRepository,
    outboxRepository,
    new PassthroughUnitOfWork(),
    new FakeClock(NOW),
    new FakeIdGenerator(),
  );
  return { walletRepository, wagerTransactionRepository, ledgerRepository, outboxRepository, useCase };
}

describe("CreateWallet", () => {
  it("cria uma wallet com saldo inicial zero, sem transação OPENING nem lançamento", async () => {
    const { useCase, wagerTransactionRepository, ledgerRepository, outboxRepository } = buildSut();

    const { wallet } = await useCase.execute({
      playerId: "player-1",
      initialBalance: { amount: "0.00", currency: "BRL" },
      correlationId: "corr-1",
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(ledgerRepository.entries).toHaveLength(0);
    expect(outboxRepository.messages).toHaveLength(0);
    expect(await wagerTransactionRepository.findById("nonexistent")).toBeUndefined();
  });

  it("cria uma wallet com saldo inicial positivo, gerando OPENING processada e lançamento CREDIT", async () => {
    const { useCase, ledgerRepository, outboxRepository } = buildSut();

    const { wallet } = await useCase.execute({
      playerId: "player-1",
      initialBalance: { amount: "1000.00", currency: "BRL" },
      correlationId: "corr-1",
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(ledgerRepository.entries).toHaveLength(1);
    expect(ledgerRepository.entries[0]!.balanceAfter.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(outboxRepository.messages.some((m) => m.eventType === "WagerTransactionProcessed")).toBe(true);
    expect(outboxRepository.messages.some((m) => m.eventType === "WalletBalanceChanged")).toBe(true);
  });

  it("a transação OPENING nasce diretamente PROCESSED", async () => {
    const { useCase, wagerTransactionRepository, ledgerRepository } = buildSut();
    const { wallet } = await useCase.execute({
      playerId: "player-1",
      initialBalance: { amount: "50.00", currency: "BRL" },
      correlationId: "corr-1",
    });
    const openingTransactionId = ledgerRepository.entries[0]!.transactionId;
    const opening = await wagerTransactionRepository.findById(openingTransactionId);
    expect(opening!.status).toBe(WagerTransactionStatus.Processed);
    expect(opening!.walletId).toBe(wallet.id);
  });
});
