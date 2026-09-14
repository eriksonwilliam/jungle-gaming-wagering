import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/domain/money/money";
import { LedgerDirection } from "../../../../src/domain/ledger/ledger-direction";
import { UnbalancedLedgerEntryError } from "../../../../src/domain/ledger/ledger.errors";
import { WalletLedgerEntry } from "../../../../src/domain/ledger/wallet-ledger-entry";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("WalletLedgerEntry", () => {
  it("cria um lançamento de crédito balanceado", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
      createdAt: NOW,
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it("cria um lançamento de débito balanceado", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
      createdAt: NOW,
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it("rejeita lançamento de crédito desbalanceado", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "entry-1",
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "999.00", currency: "BRL" }),
        createdAt: NOW,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it("rejeita lançamento de débito desbalanceado", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "entry-1",
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "999.00", currency: "BRL" }),
        createdAt: NOW,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it("rehydrate reconstrói sem revalidar", () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
      createdAt: NOW,
    });
    expect(entry.id).toBe("entry-1");
    expect(entry.isBalanced()).toBe(true);
  });
});
