import { describe, expect, it } from "bun:test";
import { LedgerDirection } from "../../../../src/domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../../src/domain/money/money";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import { WalletNotFoundError } from "../../../../src/application/errors/wallet-not-found.error";
import { ReconcileWallet } from "../../../../src/application/use-cases/reconcile-wallet.use-case";
import { FakeLogger, FakeMetrics, InMemoryLedgerRepository, InMemoryWalletRepository } from "../support/fakes";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function buildSut() {
  const walletRepository = new InMemoryWalletRepository();
  const ledgerRepository = new InMemoryLedgerRepository();
  const logger = new FakeLogger();
  const metrics = new FakeMetrics();
  const useCase = new ReconcileWallet(walletRepository, ledgerRepository, logger, metrics);
  return { walletRepository, ledgerRepository, logger, metrics, useCase };
}

describe("ReconcileWallet", () => {
  it("lança WalletNotFoundError quando a wallet não existe", async () => {
    const { useCase } = buildSut();
    await expect(useCase.execute("nope")).rejects.toThrow(WalletNotFoundError);
  });

  it("relata consistência quando o saldo bate com o ledger", async () => {
    const { useCase, walletRepository, ledgerRepository, logger, metrics } = buildSut();
    const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: NOW });
    walletRepository.seed(wallet);
    await ledgerRepository.save(
      WalletLedgerEntry.create({
        id: "e1",
        walletId: "w1",
        transactionId: "tx-1",
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceBefore: Money.zero("BRL"),
        balanceAfter: Money.from({ amount: "100.00", currency: "BRL" }),
        createdAt: NOW,
      }),
    );

    const result = await useCase.execute("w1");

    expect(result.consistent).toBe(true);
    expect(result.difference.isZero()).toBe(true);
    expect(result.checkedEntries).toBe(1);
    expect(logger.entries).toHaveLength(0);
    expect(metrics.counters["wallet_reconciliation_divergence_total"]).toBeUndefined();
  });

  it("relata, loga e contabiliza divergência quando o saldo não bate com o ledger", async () => {
    const { useCase, walletRepository, ledgerRepository, logger, metrics } = buildSut();
    const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: Money.from({ amount: "999.00", currency: "BRL" }), now: NOW });
    walletRepository.seed(wallet);
    await ledgerRepository.save(
      WalletLedgerEntry.create({
        id: "e1",
        walletId: "w1",
        transactionId: "tx-1",
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceBefore: Money.zero("BRL"),
        balanceAfter: Money.from({ amount: "100.00", currency: "BRL" }),
        createdAt: NOW,
      }),
    );

    const result = await useCase.execute("w1");

    expect(result.consistent).toBe(false);
    expect(result.difference.toJSON()).toEqual({ amount: "899.00", currency: "BRL" });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.level).toBe("error");
    expect(metrics.counters["wallet_reconciliation_divergence_total"]).toBe(1);
  });

  it("relata saldo zero quando a wallet não tem nenhum lançamento", async () => {
    const { useCase, walletRepository } = buildSut();
    const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: Money.zero("BRL"), now: NOW });
    walletRepository.seed(wallet);

    const result = await useCase.execute("w1");

    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
  });
});
