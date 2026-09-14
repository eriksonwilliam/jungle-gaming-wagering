export class WalletAlreadyExistsError extends Error {
  constructor(
    public readonly playerId: string,
    public readonly currency: string,
  ) {
    super(`já existe uma wallet para playerId=${playerId} currency=${currency}`);
    this.name = "WalletAlreadyExistsError";
  }
}
