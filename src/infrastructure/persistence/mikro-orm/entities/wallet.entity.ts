import { Entity, PrimaryKey, Property, Unique } from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"], name: "wallets_player_currency_key" })
export class WalletEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "player_id", type: "uuid" })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  /** Centavos, como string — bigint do Postgres é exato mas o driver retorna string; convertido para bigint no repositório. */
  @Property({ fieldName: "balance_minor_units", type: "bigint" })
  balanceMinorUnits!: string;

  @Property()
  version!: number;

  @Property({ fieldName: "created_at" })
  createdAt!: Date;

  @Property({ fieldName: "updated_at" })
  updatedAt!: Date;
}
