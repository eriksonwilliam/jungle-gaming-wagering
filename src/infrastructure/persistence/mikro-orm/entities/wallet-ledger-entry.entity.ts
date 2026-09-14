import { Entity, Enum, Index, PrimaryKey, Property, Unique } from "@mikro-orm/decorators/legacy";
import { LedgerDirection } from "../../../../domain/ledger/ledger-direction";

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({ properties: ["walletId", "transactionId"], name: "ledger_wallet_transaction_key" })
@Index({ properties: ["walletId", "createdAt"], name: "ledger_wallet_created_idx" })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "transaction_id", type: "uuid" })
  transactionId!: string;

  @Enum({ items: () => LedgerDirection })
  direction!: LedgerDirection;

  @Property({ fieldName: "amount_minor_units", type: "bigint" })
  amountMinorUnits!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ fieldName: "balance_before_minor_units", type: "bigint" })
  balanceBeforeMinorUnits!: string;

  @Property({ fieldName: "balance_after_minor_units", type: "bigint" })
  balanceAfterMinorUnits!: string;

  @Property({ fieldName: "created_at" })
  createdAt!: Date;
}
