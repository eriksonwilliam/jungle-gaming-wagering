/** Falha transitória de infraestrutura (PostgreSQL/SQS indisponível) — o provedor deve reenviar. */
export class ServiceUnavailableError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
