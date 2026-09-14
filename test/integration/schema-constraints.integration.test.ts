import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildDependencies, type TestDependencies } from "./support/build-dependencies";
import { startTestDatabase, type TestDatabase } from "./support/test-database";

let db: TestDatabase;
let deps: TestDependencies;

beforeAll(async () => {
  db = await startTestDatabase();
  deps = buildDependencies(db.orm);
}, 60_000);

afterAll(async () => {
  await db.stop();
});

describe("Schema — constraints reais do Postgres", () => {
  it("impede duas wallets para o mesmo playerId + currency (unique constraint)", async () => {
    const playerId = randomUUID();
    await deps.run(() => deps.createWallet.execute({ playerId, initialBalance: { amount: "0.00", currency: "BRL" }, correlationId: "c1" }));

    await expect(
      deps.run(() => deps.createWallet.execute({ playerId, initialBalance: { amount: "0.00", currency: "BRL" }, correlationId: "c2" })),
    ).rejects.toThrow();
  });

  it("impede saldo negativo diretamente no schema (CHECK constraint)", async () => {
    const connection = db.orm.em.getConnection();
    await expect(
      connection.execute(
        `insert into wallets (id, player_id, currency, balance_minor_units, version, created_at, updated_at)
         values (?, ?, 'BRL', -100, 1, now(), now())`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it("impede UPDATE e DELETE em wallet_ledger_entries (trigger de imutabilidade)", async () => {
    const playerId = randomUUID();
    const { wallet } = await deps.run(() =>
      deps.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "c1" }),
    );
    const page = await deps.run(() => deps.ledgerRepository.findByWallet(wallet.id, undefined, 10));
    const entryId = page.entries[0]!.id;

    const connection = db.orm.em.getConnection();
    await expect(connection.execute(`update wallet_ledger_entries set amount_minor_units = 1 where id = ?`, [entryId])).rejects.toThrow();
    await expect(connection.execute(`delete from wallet_ledger_entries where id = ?`, [entryId])).rejects.toThrow();
  });

  it("impede duas reversões PROCESSED do mesmo tipo para a mesma referência (índice único parcial)", async () => {
    const playerId = randomUUID();
    const walletId = randomUUID();
    await db.orm.em.getConnection().execute(
      `insert into wallets (id, player_id, currency, balance_minor_units, version, created_at, updated_at)
       values (?, ?, 'BRL', 100000, 1, now(), now())`,
      [walletId, playerId],
    );
    const referenceTransactionId = randomUUID();
    await db.orm.em.getConnection().execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount_minor_units, currency, created_at, status)
       values (?, 'p', 'ext-bet', 'p:ext-bet', 'h', ?, ?, 'r', 'g', 'BET', 1000, 'BRL', now(), 'PROCESSED')`,
      [referenceTransactionId, walletId, playerId],
    );

    const insertRefund = (externalId: string) =>
      db.orm.em
        .getConnection()
        .execute(
          `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount_minor_units, currency, created_at, status, reference_transaction_id)
           values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'REFUND', 1000, 'BRL', now(), 'PROCESSED', ?)`,
          [randomUUID(), externalId, `p:${externalId}`, walletId, playerId, referenceTransactionId],
        );

    await insertRefund("refund-1");
    await expect(insertRefund("refund-2")).rejects.toThrow();
  });
});
