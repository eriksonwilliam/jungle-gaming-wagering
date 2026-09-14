import type { Money } from "../../domain/money/money";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

export interface LedgerReconciliation {
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;

  findByWallet(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;

  /** Recalcula o saldo a partir da soma dos lançamentos — usado na reconciliação. */
  reconcile(walletId: string): Promise<LedgerReconciliation>;
}
