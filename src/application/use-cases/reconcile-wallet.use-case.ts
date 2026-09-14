import type { Money } from "../../domain/money/money";
import { WalletNotFoundError } from "../errors/wallet-not-found.error";
import type { LedgerRepository } from "../ports/ledger-repository.port";
import type { Logger } from "../ports/logger.port";
import type { Metrics } from "../ports/metrics.port";
import type { WalletRepository } from "../ports/wallet-repository.port";

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Divergências não são corrigidas silenciosamente: são logadas, contabilizadas
 * em métrica e sinalizadas na resposta — nunca ajustadas automaticamente.
 */
export class ReconcileWallet {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const { calculatedBalance, checkedEntries } = await this.ledgerRepository.reconcile(walletId);
    const consistent = wallet.balance.equals(calculatedBalance);
    const difference = wallet.balance.subtract(calculatedBalance);

    if (!consistent) {
      this.logger.error("wallet_reconciliation_divergence", {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        checkedEntries,
      });
      this.metrics.incrementCounter("wallet_reconciliation_divergence_total");
    }

    return { walletId, storedBalance: wallet.balance, calculatedBalance, difference, consistent, checkedEntries };
  }
}
