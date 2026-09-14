import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import type { SQSClient } from "@aws-sdk/client-sqs";
import mikroOrmConfig from "../persistence/mikro-orm/mikro-orm.config";

import { CryptoIdGenerator } from "../adapters/crypto-id-generator.adapter";
import { SystemClock } from "../adapters/system-clock.adapter";
import { KeycloakAuthGuard } from "../identity/keycloak/keycloak-auth.guard";
import { KeycloakJwtVerifier } from "../identity/keycloak/keycloak-jwt-verifier";
import { WagerTransactionConsumer } from "../messaging/sqs/wager-transaction.consumer";
import { SqsEventPublisher } from "../messaging/sqs/sqs-event-publisher.adapter";
import { createSqsClient } from "../messaging/sqs/sqs-client.provider";
import { ConsoleLogger } from "../observability/console-logger.adapter";
import { PrometheusMetrics } from "../observability/prometheus-metrics.adapter";
import { MikroOrmSqsReadinessCheck } from "../observability/readiness-check.adapter";
import { MikroOrmInboxRepository } from "../persistence/mikro-orm/repositories/inbox.repository";
import { MikroOrmLedgerRepository } from "../persistence/mikro-orm/repositories/ledger.repository";
import { MikroOrmOutboxRepository } from "../persistence/mikro-orm/repositories/outbox.repository";
import { MikroOrmWagerTransactionRepository } from "../persistence/mikro-orm/repositories/wager-transaction.repository";
import { MikroOrmWalletRepository } from "../persistence/mikro-orm/repositories/wallet.repository";
import { MikroOrmUnitOfWork } from "../persistence/mikro-orm/unit-of-work.adapter";
import { DlqDepthScheduler } from "../scheduling/dlq-depth.scheduler";
import { OutboxPublisherScheduler } from "../scheduling/outbox-publisher.scheduler";
import { PendingReferenceScheduler } from "../scheduling/pending-reference.scheduler";
import { ApplicationExceptionFilter } from "../http/filters/application-exception.filter";
import { HealthController } from "../http/controllers/health.controller";
import { MetricsController } from "../http/controllers/metrics.controller";
import { WageringController } from "../http/controllers/wagering.controller";
import { WalletsController } from "../http/controllers/wallets.controller";
import {
  CLOCK,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  INBOX_REPOSITORY,
  LEDGER_REPOSITORY,
  LOGGER,
  METRICS,
  OUTBOX_REPOSITORY,
  READINESS_CHECK,
  SQS_CLIENT,
  UNIT_OF_WORK,
  WAGERING_EVENTS_QUEUE_URL,
  WAGER_TRANSACTIONS_QUEUE_URL,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from "../tokens";

import { ConsumeWagerTransactionMessage } from "../../application/use-cases/consume-wager-transaction-message.use-case";
import { CreateWallet } from "../../application/use-cases/create-wallet.use-case";
import { GetWagerTransaction } from "../../application/use-cases/get-wager-transaction.use-case";
import { GetWalletLedger } from "../../application/use-cases/get-wallet-ledger.use-case";
import { GetWallet } from "../../application/use-cases/get-wallet.use-case";
import { ProcessPendingReferences } from "../../application/use-cases/process-pending-references.use-case";
import { PublishOutboxBatch } from "../../application/use-cases/publish-outbox-batch.use-case";
import { ReconcileWallet } from "../../application/use-cases/reconcile-wallet.use-case";
import { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction.use-case";
import type { WalletRepository } from "../../application/ports/wallet-repository.port";
import type { WagerTransactionRepository } from "../../application/ports/wager-transaction-repository.port";
import type { LedgerRepository } from "../../application/ports/ledger-repository.port";
import type { OutboxRepository } from "../../application/ports/outbox-repository.port";
import type { InboxRepository } from "../../application/ports/inbox-repository.port";
import type { UnitOfWork } from "../../application/ports/unit-of-work.port";
import type { Clock } from "../../application/ports/clock.port";
import type { IdGenerator } from "../../application/ports/id-generator.port";
import type { Logger } from "../../application/ports/logger.port";

const env = (key: string, fallback = ""): string => process.env[key] ?? fallback;

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: CryptoIdGenerator },
    { provide: LOGGER, useClass: ConsoleLogger },
    { provide: METRICS, useClass: PrometheusMetrics },
    { provide: SQS_CLIENT, useFactory: createSqsClient },
    { provide: WAGER_TRANSACTIONS_QUEUE_URL, useValue: env("WAGER_TRANSACTIONS_QUEUE_URL") },
    { provide: WAGERING_EVENTS_QUEUE_URL, useValue: env("WAGERING_EVENTS_QUEUE_URL") },

    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
      inject: [MikroORM],
    },
    {
      provide: WALLET_REPOSITORY,
      useFactory: (em: EntityManager) => new MikroOrmWalletRepository(em),
      inject: [EntityManager],
    },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      useFactory: (em: EntityManager) => new MikroOrmWagerTransactionRepository(em),
      inject: [EntityManager],
    },
    {
      provide: LEDGER_REPOSITORY,
      useFactory: (em: EntityManager) => new MikroOrmLedgerRepository(em),
      inject: [EntityManager],
    },
    {
      provide: INBOX_REPOSITORY,
      useFactory: (em: EntityManager) => new MikroOrmInboxRepository(em),
      inject: [EntityManager],
    },
    {
      provide: OUTBOX_REPOSITORY,
      useFactory: (em: EntityManager) => new MikroOrmOutboxRepository(em),
      inject: [EntityManager],
    },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (client: SQSClient) => new SqsEventPublisher(client, env("WAGERING_EVENTS_QUEUE_URL")),
      inject: [SQS_CLIENT],
    },
    {
      provide: READINESS_CHECK,
      useFactory: (em: EntityManager, client: SQSClient) =>
        new MikroOrmSqsReadinessCheck(em, client, env("WAGER_TRANSACTIONS_QUEUE_URL")),
      inject: [EntityManager, SQS_CLIENT],
    },

    {
      provide: CreateWallet,
      useFactory: (
        walletRepo: WalletRepository,
        txRepo: WagerTransactionRepository,
        ledgerRepo: LedgerRepository,
        outboxRepo: OutboxRepository,
        uow: UnitOfWork,
        clock: Clock,
        idGen: IdGenerator,
      ) => new CreateWallet(walletRepo, txRepo, ledgerRepo, outboxRepo, uow, clock, idGen),
      inject: [WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, LEDGER_REPOSITORY, OUTBOX_REPOSITORY, UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: SubmitWagerTransaction,
      useFactory: (
        walletRepo: WalletRepository,
        txRepo: WagerTransactionRepository,
        ledgerRepo: LedgerRepository,
        outboxRepo: OutboxRepository,
        uow: UnitOfWork,
        clock: Clock,
        idGen: IdGenerator,
        metrics: PrometheusMetrics,
      ) => new SubmitWagerTransaction(walletRepo, txRepo, ledgerRepo, outboxRepo, uow, clock, idGen, metrics),
      inject: [WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, LEDGER_REPOSITORY, OUTBOX_REPOSITORY, UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS],
    },
    {
      provide: ConsumeWagerTransactionMessage,
      useFactory: (inboxRepo: InboxRepository, submit: SubmitWagerTransaction, uow: UnitOfWork, clock: Clock) =>
        new ConsumeWagerTransactionMessage(inboxRepo, submit, uow, clock),
      inject: [INBOX_REPOSITORY, SubmitWagerTransaction, UNIT_OF_WORK, CLOCK],
    },
    {
      provide: ProcessPendingReferences,
      useFactory: (
        walletRepo: WalletRepository,
        txRepo: WagerTransactionRepository,
        ledgerRepo: LedgerRepository,
        outboxRepo: OutboxRepository,
        uow: UnitOfWork,
        clock: Clock,
        idGen: IdGenerator,
        metrics: PrometheusMetrics,
      ) => new ProcessPendingReferences(walletRepo, txRepo, ledgerRepo, outboxRepo, uow, clock, idGen, metrics),
      inject: [WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, LEDGER_REPOSITORY, OUTBOX_REPOSITORY, UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS],
    },
    {
      provide: PublishOutboxBatch,
      useFactory: (outboxRepo: OutboxRepository, publisher: SqsEventPublisher, clock: Clock, logger: Logger, metrics: PrometheusMetrics) =>
        new PublishOutboxBatch(outboxRepo, publisher, clock, logger, metrics),
      inject: [OUTBOX_REPOSITORY, EVENT_PUBLISHER, CLOCK, LOGGER, METRICS],
    },
    {
      provide: GetWallet,
      useFactory: (walletRepo: WalletRepository) => new GetWallet(walletRepo),
      inject: [WALLET_REPOSITORY],
    },
    {
      provide: GetWalletLedger,
      useFactory: (ledgerRepo: LedgerRepository) => new GetWalletLedger(ledgerRepo),
      inject: [LEDGER_REPOSITORY],
    },
    {
      provide: GetWagerTransaction,
      useFactory: (txRepo: WagerTransactionRepository) => new GetWagerTransaction(txRepo),
      inject: [WAGER_TRANSACTION_REPOSITORY],
    },
    {
      provide: ReconcileWallet,
      useFactory: (walletRepo: WalletRepository, ledgerRepo: LedgerRepository, logger: Logger, metrics: PrometheusMetrics) =>
        new ReconcileWallet(walletRepo, ledgerRepo, logger, metrics),
      inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY, LOGGER, METRICS],
    },

    {
      provide: KeycloakJwtVerifier,
      useFactory: () =>
        new KeycloakJwtVerifier(
          env("KEYCLOAK_JWKS_URL"),
          env("KEYCLOAK_ISSUER"),
          env("KEYCLOAK_AUDIENCE") || undefined,
        ),
    },
    { provide: APP_GUARD, useClass: KeycloakAuthGuard },
    Reflector,
    {
      provide: APP_FILTER,
      useFactory: (logger: Logger) => new ApplicationExceptionFilter(logger),
      inject: [LOGGER],
    },

    {
      provide: WagerTransactionConsumer,
      useFactory: (
        orm: MikroORM,
        client: SQSClient,
        consume: ConsumeWagerTransactionMessage,
        logger: Logger,
        metrics: PrometheusMetrics,
      ) => new WagerTransactionConsumer(orm, client, env("WAGER_TRANSACTIONS_QUEUE_URL"), consume, logger, metrics),
      inject: [MikroORM, SQS_CLIENT, ConsumeWagerTransactionMessage, LOGGER, METRICS],
    },
    {
      provide: OutboxPublisherScheduler,
      useFactory: (orm: MikroORM, publishBatch: PublishOutboxBatch) => new OutboxPublisherScheduler(orm, publishBatch),
      inject: [MikroORM, PublishOutboxBatch],
    },
    {
      provide: PendingReferenceScheduler,
      useFactory: (orm: MikroORM, processRefs: ProcessPendingReferences) => new PendingReferenceScheduler(orm, processRefs),
      inject: [MikroORM, ProcessPendingReferences],
    },
    {
      provide: DlqDepthScheduler,
      useFactory: (client: SQSClient, metrics: PrometheusMetrics) =>
        new DlqDepthScheduler(client, env("WAGER_TRANSACTIONS_DLQ_QUEUE_URL"), metrics),
      inject: [SQS_CLIENT, METRICS],
    },
  ],
})
export class AppModule {}
