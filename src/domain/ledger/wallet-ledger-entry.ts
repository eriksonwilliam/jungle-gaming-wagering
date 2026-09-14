import { Money } from "../money/money";
import { LedgerDirection } from "./ledger-direction";
import { UnbalancedLedgerEntryError } from "./ledger.errors";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento de ledger imutável. Sem campos mutáveis, sem métodos de
 * transição — a imutabilidade é estrutural. `create` valida a aritmética do
 * lançamento (balanceBefore ± money === balanceAfter) e nunca deve ser
 * chamada duas vezes para a mesma transação/wallet (unicidade garantida no
 * schema, não aqui).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `lançamento desbalanceado na wallet ${props.walletId}: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} !== ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida a aritmética. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
