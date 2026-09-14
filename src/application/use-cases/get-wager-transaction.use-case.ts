import type { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository.port";

export class GetWagerTransaction {
  constructor(private readonly wagerTransactionRepository: WagerTransactionRepository) {}

  async byId(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.wagerTransactionRepository.findById(transactionId);
  }

  async byProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.wagerTransactionRepository.findByProviderAndExternalId(providerId, externalTransactionId);
  }
}
