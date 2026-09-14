import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";
import mikroOrmConfig from "../../src/infrastructure/persistence/mikro-orm/mikro-orm.config";
import { buildDependencies, type TestDependencies } from "../integration/support/build-dependencies";
import { startTestDatabase, type TestDatabase } from "../integration/support/test-database";

let db: TestDatabase;
let instances: { orm: MikroORM; deps: TestDependencies }[];

const INSTANCE_COUNT = 3;

beforeAll(async () => {
  db = await startTestDatabase();
  const clientUrl = (db.orm.config.get("clientUrl") as string) ?? undefined;

  instances = [{ orm: db.orm, deps: buildDependencies(db.orm) }];
  for (let i = 1; i < INSTANCE_COUNT; i += 1) {
    const orm = await MikroORM.init({ ...mikroOrmConfig, clientUrl });
    instances.push({ orm, deps: buildDependencies(orm) });
  }
}, 60_000);

afterAll(async () => {
  for (const instance of instances.slice(1)) {
    await instance.orm.close();
  }
  await db.stop();
});

/**
 * Simula 3+ instâncias da aplicação (3 conexões/EntityManagers independentes,
 * como em réplicas separadas) tocando a mesma wallet e wallets diferentes ao
 * mesmo tempo — a correção depende do lock a nível de banco, não de qualquer
 * coordenação em memória de um único processo.
 */
describe("Concorrência — múltiplas instâncias reais", () => {
  it(`${INSTANCE_COUNT} instâncias disputando a mesma wallet: só uma aposta de 80 processa contra saldo de 100`, async () => {
    const playerId = randomUUID();
    const { wallet } = await instances[0]!.deps.run(() =>
      instances[0]!.deps.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }),
    );

    const results = await Promise.all(
      instances.map((instance, index) =>
        instance.deps.run(() =>
          instance.deps.submitWagerTransaction.execute({
            providerId: "provider-a",
            externalTransactionId: `bet-${index}`,
            idempotencyKey: `provider-a:bet-${index}`,
            payloadHash: `hash-${index}`,
            playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "game-1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "80.00", currency: "BRL" },
            correlationId: `corr-${index}`,
          }),
        ),
      ),
    );

    const processedCount = results.filter((r) => r.transaction.status === WagerTransactionStatus.Processed).length;
    expect(processedCount).toBe(1);
    expect(results.filter((r) => r.transaction.status === WagerTransactionStatus.Rejected)).toHaveLength(INSTANCE_COUNT - 1);

    const finalWallet = await instances[0]!.deps.run(() => instances[0]!.deps.walletRepository.findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "20.00", currency: "BRL" });
  });

  it("instâncias diferentes processam wallets diferentes em paralelo sem interferência", async () => {
    const wallets = await Promise.all(
      instances.map((instance) =>
        instance.deps.run(() =>
          instance.deps.createWallet.execute({
            playerId: randomUUID(),
            initialBalance: { amount: "100.00", currency: "BRL" },
            correlationId: "setup",
          }),
        ),
      ),
    );

    const results = await Promise.all(
      instances.map((instance, index) =>
        instance.deps.run(() =>
          instance.deps.submitWagerTransaction.execute({
            providerId: "provider-a",
            externalTransactionId: `iso-${index}`,
            idempotencyKey: `provider-a:iso-${index}`,
            payloadHash: `hash-${index}`,
            playerId: wallets[index]!.wallet.playerId,
            walletId: wallets[index]!.wallet.id,
            roundId: "round-1",
            gameId: "game-1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "30.00", currency: "BRL" },
            correlationId: `corr-iso-${index}`,
          }),
        ),
      ),
    );

    expect(results.every((r) => r.transaction.status === WagerTransactionStatus.Processed)).toBe(true);
    for (let index = 0; index < INSTANCE_COUNT; index += 1) {
      const wallet = await instances[0]!.deps.run(() => instances[0]!.deps.walletRepository.findById(wallets[index]!.wallet.id));
      expect(wallet!.balance.toJSON()).toEqual({ amount: "70.00", currency: "BRL" });
    }
  });
});
