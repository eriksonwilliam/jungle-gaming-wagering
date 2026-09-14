import type { Wallet } from "../../domain/wallet/wallet";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;

  /**
   * Lê a wallet com lock pessimista de linha (`SELECT ... FOR UPDATE`).
   * Só deve ser chamado dentro de `UnitOfWork.run` — é o mecanismo que
   * serializa operações concorrentes na mesma wallet.
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;

  save(wallet: Wallet): Promise<void>;
}
