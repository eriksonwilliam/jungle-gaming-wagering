import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/domain/money/money";
import { CurrencyMismatchError } from "../../../../src/domain/money/money.errors";
import { LedgerDirection } from "../../../../src/domain/ledger/ledger-direction";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import { InsufficientBalanceError } from "../../../../src/domain/wallet/wallet.errors";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-01T00:05:00.000Z");

function openWallet(initialBalance = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: initialBalance, currency: "BRL" }),
    now: NOW,
  });
}

describe("Wallet", () => {
  describe("open", () => {
    it("inicia com version 1, mesmo com saldo inicial positivo", () => {
      const wallet = openWallet("1000.00");
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(wallet.currency).toBe("BRL");
      expect(wallet.updatedAt).toEqual(NOW);
    });

    it("aceita saldo inicial zero", () => {
      const wallet = openWallet("0.00");
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
    });
  });

  describe("debit", () => {
    it("debita e produz um lançamento de débito balanceado, incrementando version", () => {
      const wallet = openWallet("100.00");
      const entry = wallet.debit(Money.from({ amount: "30.00", currency: "BRL" }), "tx-1", "entry-1", LATER);
      expect(wallet.balance.toJSON()).toEqual({ amount: "70.00", currency: "BRL" });
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
      expect(entry.balanceAfter.toJSON()).toEqual({ amount: "70.00", currency: "BRL" });
      expect(entry.isBalanced()).toBe(true);
    });

    it("permite debitar exatamente o saldo disponível (chega a zero)", () => {
      const wallet = openWallet("50.00");
      wallet.debit(Money.from({ amount: "50.00", currency: "BRL" }), "tx-1", "entry-1", LATER);
      expect(wallet.balance.isZero()).toBe(true);
    });

    it("rejeita débito que deixaria o saldo negativo", () => {
      const wallet = openWallet("50.00");
      expect(() => wallet.debit(Money.from({ amount: "50.01", currency: "BRL" }), "tx-1", "entry-1", LATER)).toThrow(
        InsufficientBalanceError,
      );
      expect(wallet.balance.toJSON()).toEqual({ amount: "50.00", currency: "BRL" });
      expect(wallet.version).toBe(1);
    });

    it("rejeita débito em moeda diferente da wallet", () => {
      const wallet = openWallet("50.00");
      expect(() => wallet.debit(Money.from({ amount: "10.00", currency: "USD" }), "tx-1", "entry-1", LATER)).toThrow(
        CurrencyMismatchError,
      );
    });

    it("cenário obrigatório: duas apostas de 80 contra saldo de 100 — apenas uma pode ser aplicada ao mesmo agregado", () => {
      const wallet = openWallet("100.00");
      const bet = Money.from({ amount: "80.00", currency: "BRL" });
      wallet.debit(bet, "tx-1", "entry-1", LATER);
      expect(() => wallet.debit(bet, "tx-2", "entry-2", LATER)).toThrow(InsufficientBalanceError);
      expect(wallet.balance.toJSON()).toEqual({ amount: "20.00", currency: "BRL" });
      expect(wallet.version).toBe(2);
    });
  });

  describe("credit", () => {
    it("credita e produz um lançamento de crédito balanceado, incrementando version", () => {
      const wallet = openWallet("100.00");
      const entry = wallet.credit(Money.from({ amount: "30.00", currency: "BRL" }), "tx-1", "entry-1", LATER);
      expect(wallet.balance.toJSON()).toEqual({ amount: "130.00", currency: "BRL" });
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.isBalanced()).toBe(true);
    });

    it("rejeita crédito em moeda diferente da wallet", () => {
      const wallet = openWallet("50.00");
      expect(() => wallet.credit(Money.from({ amount: "10.00", currency: "USD" }), "tx-1", "entry-1", LATER)).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe("rehydrate", () => {
    it("reconstrói o estado exatamente como persistido", () => {
      const wallet = Wallet.rehydrate({
        id: "wallet-1",
        playerId: "player-1",
        currency: "BRL",
        balance: Money.from({ amount: "42.00", currency: "BRL" }),
        version: 7,
        createdAt: NOW,
        updatedAt: LATER,
      });
      expect(wallet.balance.toJSON()).toEqual({ amount: "42.00", currency: "BRL" });
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toEqual(NOW);
      expect(wallet.updatedAt).toEqual(LATER);
    });
  });
});
