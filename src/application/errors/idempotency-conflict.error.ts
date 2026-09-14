export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`idempotency key já usada com payload diferente: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}
