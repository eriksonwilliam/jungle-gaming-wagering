import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface OutboxRepository {
  save(message: OutboxMessage): Promise<void>;

  /**
   * Reivindica um lote pendente e devido para publicação. Implementado no
   * adapter com `SELECT ... FOR UPDATE SKIP LOCKED`, dentro de uma transação
   * curta própria — permite múltiplos publishers concorrentes sem disputa.
   */
  claimDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;

  update(message: OutboxMessage): Promise<void>;
}
