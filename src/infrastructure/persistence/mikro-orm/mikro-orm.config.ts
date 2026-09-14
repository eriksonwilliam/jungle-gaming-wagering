import { defineConfig } from "@mikro-orm/postgresql";
import { ReflectMetadataProvider } from "@mikro-orm/decorators/legacy";
import { Migration20260101120000 } from "../../../../migrations/Migration20260101120000";
import { InboxMessageEntity } from "./entities/inbox-message.entity";
import { OutboxMessageEntity } from "./entities/outbox-message.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "./entities/wallet-ledger-entry.entity";
import { WalletEntity } from "./entities/wallet.entity";

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering",
  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
  // MikroORM v7 tirou os decorators do core e não registra mais a inferência
  // de tipo via reflect-metadata por padrão — sem isso, toda propriedade sem
  // `type` explícito falha na descoberta de metadados.
  metadataProvider: ReflectMetadataProvider,
  migrations: {
    // Lista explícita em vez de scan de pasta: o scan dinâmico de .ts do
    // MikroORM aciona uma detecção de loader (ts-node/rushstack) incompatível
    // com o Bun (puxa uma cadeia de `ajv-draft-04` quebrada). Import estático
    // funciona nativamente — Bun já executa TypeScript sem loader nenhum.
    migrationsList: [{ name: "Migration20260101120000", class: Migration20260101120000 }],
    transactional: true,
  },
  debug: process.env.MIKRO_ORM_DEBUG === "true",
});
