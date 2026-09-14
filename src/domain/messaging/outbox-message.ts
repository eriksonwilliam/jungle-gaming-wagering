import type { IntegrationEvent } from "./integration-event";

const RETRY_BASE_MS = 30_000;
const RETRY_FACTOR = 2;
const RETRY_MAX_MS = 30 * 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Relay transacional: gravada na mesma transação SQL que a mudança de
 * saldo, publicada depois por um worker que pode rodar em múltiplas
 * instâncias (`SELECT ... FOR UPDATE SKIP LOCKED` no adapter de
 * persistência — ver ARCHITECTURE.md).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(id: string, event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      id,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) {
      return false;
    }
    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial, cap 30min). */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delayMs = Math.min(RETRY_BASE_MS * RETRY_FACTOR ** (this._attempts - 1), RETRY_MAX_MS);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
