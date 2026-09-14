/**
 * Duas requisições com a mesma Idempotency-Key correram em paralelo, ambas
 * viram "não existe ainda" na checagem inicial, e o INSERT desta perdeu a
 * corrida contra a constraint única do banco — a outra venceu. Não é um erro
 * de negócio: o chamador deve buscar o resultado da vencedora e devolvê-lo
 * como replay idempotente.
 */
export class IdempotencyRaceLostError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`corrida de idempotência perdida para idempotencyKey=${idempotencyKey}`);
    this.name = "IdempotencyRaceLostError";
  }
}
