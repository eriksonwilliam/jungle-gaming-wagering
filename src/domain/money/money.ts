import { CurrencyMismatchError, InvalidMoneyError } from "./money.errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Dinheiro imutável, representado internamente em centavos (bigint).
 * Moedas com escala fixa de 2 casas são exatamente representáveis como
 * inteiro — evita qualquer erro de arredondamento de ponto flutuante e
 * dispensa uma biblioteca de decimal externa.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /** Parseia um contrato externo (string decimal). Rejeita entradas inválidas ou negativas. */
  static from(props: MoneyProps): Money {
    if (typeof props.currency !== "string" || !CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(
        `currency inválida: "${String(props.currency)}" — use código ISO-4217 de 3 letras maiúsculas`,
      );
    }
    if (typeof props.amount !== "string" || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `amount inválido: "${String(props.amount)}" — use string decimal não negativa com exatamente 2 casas (ex.: "25.00")`,
      );
    }
    return new Money(parseDecimalToMinorUnits(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  /** Reconstrução a partir de um valor já validado (persistência). Não revalida formato. */
  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    return new Money(minorUnits, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** Valor exato em centavos — usado pelo adapter de persistência. */
  toMinorUnits(): bigint {
    return this.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: formatMinorUnits(this.minorUnits), currency: this.currency };
  }

  toString(): string {
    return `${formatMinorUnits(this.minorUnits)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

function parseDecimalToMinorUnits(amount: string): bigint {
  const [integerPart, fractionPart] = amount.split(".") as [string, string];
  return BigInt(integerPart) * 100n + BigInt(fractionPart);
}

function formatMinorUnits(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const integerPart = absolute / 100n;
  const fractionPart = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${integerPart}.${fractionPart}`;
}
