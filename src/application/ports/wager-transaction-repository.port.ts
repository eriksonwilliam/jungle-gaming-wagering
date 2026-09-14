import type { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction";

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;

  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;

  save(transaction: WagerTransaction): Promise<void>;

  /** PENDING_REFERENCE cuja próxima tentativa já é devida, para o worker de reprocessamento. */
  findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]>;

  /** Já existe uma reversão do tipo `kind` PROCESSED para `referenceTransactionId`? */
  existsProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
}
