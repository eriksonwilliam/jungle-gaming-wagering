import { Money } from "../money/money";
import { CurrencyMismatchError } from "../money/money.errors";
import { LedgerDirection } from "../ledger/ledger-direction";
import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { InsufficientBalanceError } from "./wallet.errors";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. A unidade de concorrência é a wallet: quem garante ausência
 * de lost update é o adapter de persistência (lock pessimista de linha), não
 * este objeto — o domínio só garante que, dada uma leitura consistente, o
 * resultado é sempre correto e nunca deixa o saldo negativo.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** version inicia em 1 após a criação, mesmo com saldo inicial > 0. */
  static open(props: OpenWalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Debita `money` e produz o lançamento correspondente. Nunca deixa o saldo negativo. */
  debit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    const balanceAfter = this._balance.subtract(money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientBalanceError(this.id, money, this._balance);
    }
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });
    this.applyBalanceChange(balanceAfter, at);
    return entry;
  }

  /** Credita `money` e produz o lançamento correspondente. */
  credit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    const balanceAfter = this._balance.add(money);
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });
    this.applyBalanceChange(balanceAfter, at);
    return entry;
  }

  private applyBalanceChange(balanceAfter: Money, at: Date): void {
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
