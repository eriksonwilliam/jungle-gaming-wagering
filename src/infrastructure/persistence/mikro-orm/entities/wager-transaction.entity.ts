import { Entity, Enum, Index, PrimaryKey, Property, Unique } from "@mikro-orm/decorators/legacy";
import type { FailureCode } from "../../../../domain/wager-transaction/failure-code";
import { WagerTransactionKind, WagerTransactionStatus } from "../../../../domain/wager-transaction/wager-transaction";

@Entity({ tableName: "wager_transactions" })
@Unique({ properties: ["providerId", "externalTransactionId"], name: "wager_tx_provider_external_key" })
@Unique({ properties: ["idempotencyKey"], name: "wager_tx_idempotency_key_key" })
@Index({ properties: ["walletId"], name: "wager_tx_wallet_id_idx" })
@Index({ properties: ["status", "referenceNextAttemptAt"], name: "wager_tx_pending_reference_idx" })
export class WagerTransactionEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "provider_id" })
  providerId!: string;

  @Property({ fieldName: "external_transaction_id" })
  externalTransactionId!: string;

  @Property({ fieldName: "idempotency_key" })
  idempotencyKey!: string;

  @Property({ fieldName: "payload_hash" })
  payloadHash!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "player_id", type: "uuid" })
  playerId!: string;

  @Property({ fieldName: "round_id" })
  roundId!: string;

  @Property({ fieldName: "game_id" })
  gameId!: string;

  @Enum({ items: () => WagerTransactionKind })
  kind!: WagerTransactionKind;

  @Property({ fieldName: "amount_minor_units", type: "bigint" })
  amountMinorUnits!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ fieldName: "reference_external_transaction_id", nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: "created_at" })
  createdAt!: Date;

  @Enum({ items: () => WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @Property({ fieldName: "reference_transaction_id", type: "uuid", nullable: true })
  referenceTransactionId?: string;

  @Property({ fieldName: "failure_code", nullable: true })
  failureCode?: FailureCode;

  @Property({ fieldName: "processed_at", nullable: true })
  processedAt?: Date;

  @Property({ fieldName: "reference_attempts" })
  referenceAttempts: number = 0;

  @Property({ fieldName: "reference_next_attempt_at", nullable: true })
  referenceNextAttemptAt?: Date;
}
