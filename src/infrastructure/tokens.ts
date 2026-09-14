/**
 * Tokens de injeção do Nest para as portas (interfaces não têm identidade em
 * runtime). Cada token é ligado ao adapter concreto no `AppModule`.
 */
export const CLOCK = Symbol("Clock");
export const ID_GENERATOR = Symbol("IdGenerator");
export const WALLET_REPOSITORY = Symbol("WalletRepository");
export const WAGER_TRANSACTION_REPOSITORY = Symbol("WagerTransactionRepository");
export const LEDGER_REPOSITORY = Symbol("LedgerRepository");
export const INBOX_REPOSITORY = Symbol("InboxRepository");
export const OUTBOX_REPOSITORY = Symbol("OutboxRepository");
export const EVENT_PUBLISHER = Symbol("EventPublisher");
export const UNIT_OF_WORK = Symbol("UnitOfWork");
export const LOGGER = Symbol("Logger");
export const METRICS = Symbol("Metrics");
export const READINESS_CHECK = Symbol("ReadinessCheck");
export const SQS_CLIENT = Symbol("SQSClient");
export const WAGER_TRANSACTIONS_QUEUE_URL = Symbol("WagerTransactionsQueueUrl");
export const WAGERING_EVENTS_QUEUE_URL = Symbol("WageringEventsQueueUrl");
