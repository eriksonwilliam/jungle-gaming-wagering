import type { MikroORM } from "@mikro-orm/postgresql";
import { CryptoIdGenerator } from "../../../src/infrastructure/adapters/crypto-id-generator.adapter";
import { SystemClock } from "../../../src/infrastructure/adapters/system-clock.adapter";
import { runInDbContext } from "../../../src/infrastructure/persistence/mikro-orm/run-in-context";
import { MikroOrmInboxRepository } from "../../../src/infrastructure/persistence/mikro-orm/repositories/inbox.repository";
import { MikroOrmLedgerRepository } from "../../../src/infrastructure/persistence/mikro-orm/repositories/ledger.repository";
import { MikroOrmOutboxRepository } from "../../../src/infrastructure/persistence/mikro-orm/repositories/outbox.repository";
import { MikroOrmWagerTransactionRepository } from "../../../src/infrastructure/persistence/mikro-orm/repositories/wager-transaction.repository";
import { MikroOrmWalletRepository } from "../../../src/infrastructure/persistence/mikro-orm/repositories/wallet.repository";
import { MikroOrmUnitOfWork } from "../../../src/infrastructure/persistence/mikro-orm/unit-of-work.adapter";
import { ConsumeWagerTransactionMessage } from "../../../src/application/use-cases/consume-wager-transaction-message.use-case";
import { CreateWallet } from "../../../src/application/use-cases/create-wallet.use-case";
import { ProcessPendingReferences } from "../../../src/application/use-cases/process-pending-references.use-case";
import { ReconcileWallet } from "../../../src/application/use-cases/reconcile-wallet.use-case";
import { SubmitWagerTransaction } from "../../../src/application/use-cases/submit-wager-transaction.use-case";
import { FakeLogger, FakeMetrics } from "../../unit/application/support/fakes";

/**
 * Constrói os mesmos use cases da aplicação real, ligados a repositórios
 * MikroORM que apontam para o Postgres do container. `run` estabelece o
 * contexto do EntityManager (equivalente ao middleware HTTP do MikroORM, que
 * não existe fora de uma requisição Nest) antes de cada operação — sem isso
 * o MikroORM rejeita o uso do EntityManager global.
 */
export function buildDependencies(orm: MikroORM) {
  const em = orm.em;
  const clock = new SystemClock();
  const idGenerator = new CryptoIdGenerator();
  const walletRepository = new MikroOrmWalletRepository(em);
  const wagerTransactionRepository = new MikroOrmWagerTransactionRepository(em);
  const ledgerRepository = new MikroOrmLedgerRepository(em);
  const inboxRepository = new MikroOrmInboxRepository(em);
  const outboxRepository = new MikroOrmOutboxRepository(em);
  const unitOfWork = new MikroOrmUnitOfWork(orm);
  const metrics = new FakeMetrics();

  const submitWagerTransaction = new SubmitWagerTransaction(
    walletRepository,
    wagerTransactionRepository,
    ledgerRepository,
    outboxRepository,
    unitOfWork,
    clock,
    idGenerator,
    metrics,
  );

  return {
    em,
    metrics,
    walletRepository,
    wagerTransactionRepository,
    ledgerRepository,
    inboxRepository,
    outboxRepository,
    unitOfWork,
    createWallet: new CreateWallet(walletRepository, wagerTransactionRepository, ledgerRepository, outboxRepository, unitOfWork, clock, idGenerator),
    submitWagerTransaction,
    consumeWagerTransactionMessage: new ConsumeWagerTransactionMessage(inboxRepository, submitWagerTransaction, unitOfWork, clock),
    processPendingReferences: new ProcessPendingReferences(
      walletRepository,
      wagerTransactionRepository,
      ledgerRepository,
      outboxRepository,
      unitOfWork,
      clock,
      idGenerator,
      metrics,
    ),
    reconcileWallet: new ReconcileWallet(walletRepository, ledgerRepository, new FakeLogger(), new FakeMetrics()),
    run: <T>(fn: () => Promise<T>): Promise<T> => runInDbContext(orm, fn),
  };
}

export type TestDependencies = ReturnType<typeof buildDependencies>;
