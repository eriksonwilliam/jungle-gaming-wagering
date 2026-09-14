import type { LedgerPage, LedgerRepository } from "../ports/ledger-repository.port";

export interface GetWalletLedgerInput {
  walletId: string;
  cursor?: string;
  limit: number;
}

export class GetWalletLedger {
  constructor(private readonly ledgerRepository: LedgerRepository) {}

  async execute(input: GetWalletLedgerInput): Promise<LedgerPage> {
    return this.ledgerRepository.findByWallet(input.walletId, input.cursor, input.limit);
  }
}
