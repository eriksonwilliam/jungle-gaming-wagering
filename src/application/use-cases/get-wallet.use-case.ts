import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletRepository } from "../ports/wallet-repository.port";

export class GetWallet {
  constructor(private readonly walletRepository: WalletRepository) {}

  async execute(walletId: string): Promise<Wallet | undefined> {
    return this.walletRepository.findById(walletId);
  }
}
