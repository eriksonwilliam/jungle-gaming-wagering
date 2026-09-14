import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../../src/domain/money/money.errors";
import { Money } from "../../../../src/domain/money/money";

describe("Money", () => {
  describe("from", () => {
    it("parseia um valor decimal válido", () => {
      const money = Money.from({ amount: "25.00", currency: "BRL" });
      expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    });

    it("aceita zero", () => {
      const money = Money.from({ amount: "0.00", currency: "BRL" });
      expect(money.isZero()).toBe(true);
    });

    it.each([["abc"], ["NaN"], ["Infinity"], ["1e10"], [""], ["25"], ["25.0"], ["25.000"], ["-25.00"], ["25,00"]])(
      "rejeita amount inválido: %p",
      (amount) => {
        expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
      },
    );

    it.each([[""], ["brl"], ["BR"], ["BRLL"], ["12A"]])("rejeita currency inválida: %p", (currency) => {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(InvalidMoneyError);
    });
  });

  describe("zero", () => {
    it("cria um valor zerado na moeda informada", () => {
      const money = Money.zero("BRL");
      expect(money.isZero()).toBe(true);
      expect(money.currency).toBe("BRL");
    });
  });

  describe("aritmética", () => {
    it("soma dois valores na mesma moeda", () => {
      const result = Money.from({ amount: "10.00", currency: "BRL" }).add(Money.from({ amount: "5.50", currency: "BRL" }));
      expect(result.toJSON()).toEqual({ amount: "15.50", currency: "BRL" });
    });

    it("subtrai dois valores na mesma moeda", () => {
      const result = Money.from({ amount: "10.00", currency: "BRL" }).subtract(
        Money.from({ amount: "3.25", currency: "BRL" }),
      );
      expect(result.toJSON()).toEqual({ amount: "6.75", currency: "BRL" });
    });

    it("subtração pode resultar em valor negativo (uso interno)", () => {
      const result = Money.from({ amount: "3.00", currency: "BRL" }).subtract(
        Money.from({ amount: "10.00", currency: "BRL" }),
      );
      expect(result.isNegative()).toBe(true);
      expect(result.toJSON()).toEqual({ amount: "-7.00", currency: "BRL" });
    });

    it("negate inverte o sinal", () => {
      const result = Money.from({ amount: "10.00", currency: "BRL" }).negate();
      expect(result.toJSON()).toEqual({ amount: "-10.00", currency: "BRL" });
      expect(result.negate().toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
    });

    it("lança CurrencyMismatchError ao somar moedas diferentes", () => {
      expect(() => Money.from({ amount: "10.00", currency: "BRL" }).add(Money.from({ amount: "10.00", currency: "USD" }))).toThrow(
        CurrencyMismatchError,
      );
    });

    it("lança CurrencyMismatchError ao subtrair moedas diferentes", () => {
      expect(() =>
        Money.from({ amount: "10.00", currency: "BRL" }).subtract(Money.from({ amount: "10.00", currency: "USD" })),
      ).toThrow(CurrencyMismatchError);
    });

    it("lança CurrencyMismatchError ao comparar moedas diferentes", () => {
      expect(() =>
        Money.from({ amount: "10.00", currency: "BRL" }).isLessThan(Money.from({ amount: "10.00", currency: "USD" })),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe("comparações", () => {
    it("isPositive / isNegative / isZero", () => {
      expect(Money.from({ amount: "1.00", currency: "BRL" }).isPositive()).toBe(true);
      expect(Money.from({ amount: "1.00", currency: "BRL" }).isNegative()).toBe(false);
      expect(Money.from({ amount: "1.00", currency: "BRL" }).negate().isNegative()).toBe(true);
      expect(Money.zero("BRL").isPositive()).toBe(false);
      expect(Money.zero("BRL").isNegative()).toBe(false);
    });

    it("isLessThan compara magnitude", () => {
      const menor = Money.from({ amount: "5.00", currency: "BRL" });
      const maior = Money.from({ amount: "10.00", currency: "BRL" });
      expect(menor.isLessThan(maior)).toBe(true);
      expect(maior.isLessThan(menor)).toBe(false);
      expect(menor.isLessThan(menor)).toBe(false);
    });

    it("equals compara valor e moeda", () => {
      const a = Money.from({ amount: "10.00", currency: "BRL" });
      const b = Money.from({ amount: "10.00", currency: "BRL" });
      const c = Money.from({ amount: "10.00", currency: "USD" });
      const d = Money.from({ amount: "10.01", currency: "BRL" });
      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
      expect(a.equals(d)).toBe(false);
    });
  });

  describe("serialização", () => {
    it("toMinorUnits expõe o valor exato em centavos", () => {
      expect(Money.from({ amount: "25.00", currency: "BRL" }).toMinorUnits()).toBe(2500n);
    });

    it("fromMinorUnits reconstrói sem revalidar formato", () => {
      const money = Money.fromMinorUnits(2500n, "BRL");
      expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    });

    it("toString formata valor e moeda", () => {
      expect(Money.from({ amount: "25.00", currency: "BRL" }).toString()).toBe("25.00 BRL");
    });
  });
});
