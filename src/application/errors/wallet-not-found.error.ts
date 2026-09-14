export class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super(`wallet não encontrada: ${walletId}`);
    this.name = "WalletNotFoundError";
  }
}
