import { WalletLedgerEntry } from "../../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../../src/domain/money/money";
import { OutboxMessage } from "../../../../src/domain/messaging/outbox-message";
import type { InboxMessage } from "../../../../src/domain/messaging/inbox-message";
import { WagerTransaction, type WagerTransactionKind } from "../../../../src/domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../../../src/domain/wallet/wallet";
import type { Clock } from "../../../../src/application/ports/clock.port";
import type { IdGenerator } from "../../../../src/application/ports/id-generator.port";
import type { WalletRepository } from "../../../../src/application/ports/wallet-repository.port";
import type { WagerTransactionRepository } from "../../../../src/application/ports/wager-transaction-repository.port";
import type { LedgerPage, LedgerReconciliation, LedgerRepository } from "../../../../src/application/ports/ledger-repository.port";
import type { InboxRepository } from "../../../../src/application/ports/inbox-repository.port";
import type { OutboxRepository } from "../../../../src/application/ports/outbox-repository.port";
import type { EventPublisher } from "../../../../src/application/ports/event-publisher.port";
import type { UnitOfWork } from "../../../../src/application/ports/unit-of-work.port";
import type { Logger, LogFields } from "../../../../src/application/ports/logger.port";
import type { Metrics } from "../../../../src/application/ports/metrics.port";

export class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeIdGenerator implements IdGenerator {
  private counter = 0;

  newId(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}

export class InMemoryWalletRepository implements WalletRepository {
  private readonly byId = new Map<string, Wallet>();

  async findById(id: string): Promise<Wallet | undefined> {
    return this.byId.get(id);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    return this.byId.get(id);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    for (const wallet of this.byId.values()) {
      if (wallet.playerId === playerId && wallet.currency === currency) {
        return wallet;
      }
    }
    return undefined;
  }

  async save(wallet: Wallet): Promise<void> {
    this.byId.set(wallet.id, wallet);
  }

  seed(wallet: Wallet): void {
    this.byId.set(wallet.id, wallet);
  }
}

export class InMemoryWagerTransactionRepository implements WagerTransactionRepository {
  private readonly byId = new Map<string, WagerTransaction>();
  failNextSaveWith: Error | undefined;

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.byId.get(id);
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    for (const tx of this.byId.values()) {
      if (tx.providerId === providerId && tx.externalTransactionId === externalTransactionId) {
        return tx;
      }
    }
    return undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    for (const tx of this.byId.values()) {
      if (tx.idempotencyKey === idempotencyKey) {
        return tx;
      }
    }
    return undefined;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    if (this.failNextSaveWith) {
      const error = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw error;
    }
    this.byId.set(transaction.id, transaction);
  }

  async findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]> {
    return [...this.byId.values()].filter((tx) => tx.isReferenceRetryDue(now)).slice(0, limit);
  }

  async existsProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    for (const tx of this.byId.values()) {
      if (tx.referenceTransactionId === referenceTransactionId && tx.kind === kind && tx.status === "PROCESSED") {
        return true;
      }
    }
    return false;
  }

  seed(transaction: WagerTransaction): void {
    this.byId.set(transaction.id, transaction);
  }
}

export class InMemoryLedgerRepository implements LedgerRepository {
  readonly entries: WalletLedgerEntry[] = [];

  async save(entry: WalletLedgerEntry): Promise<void> {
    this.entries.push(entry);
  }

  async findByWallet(walletId: string, _cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const entries = this.entries.filter((entry) => entry.walletId === walletId).slice(0, limit);
    return { entries, nextCursor: undefined };
  }

  async reconcile(walletId: string): Promise<LedgerReconciliation> {
    const entries = this.entries.filter((entry) => entry.walletId === walletId);
    if (entries.length === 0) {
      return { calculatedBalance: Money.zero("BRL"), checkedEntries: 0 };
    }
    let balance = Money.zero(entries[0]!.money.currency);
    for (const entry of entries) {
      balance = entry.direction === "CREDIT" ? balance.add(entry.money) : balance.subtract(entry.money);
    }
    return { calculatedBalance: balance, checkedEntries: entries.length };
  }
}

export class InMemoryInboxRepository implements InboxRepository {
  private readonly store = new Map<string, InboxMessage>();

  private key(consumerName: string, messageId: string): string {
    return `${consumerName}::${messageId}`;
  }

  async findByConsumerAndMessageId(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    return this.store.get(this.key(consumerName, messageId));
  }

  async save(message: InboxMessage): Promise<void> {
    this.store.set(this.key(message.consumerName, message.messageId), message);
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  readonly messages: OutboxMessage[] = [];

  async save(message: OutboxMessage): Promise<void> {
    this.messages.push(message);
  }

  async claimDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    return this.messages.filter((message) => message.isDue(now)).slice(0, limit);
  }

  async update(_message: OutboxMessage): Promise<void> {
    // as instâncias em `messages` já são mutadas diretamente pelos casos de uso (mesma referência).
  }
}

export class FakeEventPublisher implements EventPublisher {
  readonly published: OutboxMessage[] = [];
  failNext = false;

  async publish(message: OutboxMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("falha simulada de publicação");
    }
    this.published.push(message);
  }
}

export class PassthroughUnitOfWork implements UnitOfWork {
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export class FakeLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];

  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: "info", message, fields });
  }

  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: "warn", message, fields });
  }

  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: "error", message, fields });
  }
}

export class FakeMetrics implements Metrics {
  readonly counters: Record<string, number> = {};
  readonly histogramObservations: Record<string, number[]> = {};
  readonly gauges: Record<string, number> = {};

  incrementCounter(name: string): void {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
  }

  observeHistogram(name: string, valueMs: number): void {
    (this.histogramObservations[name] ??= []).push(valueMs);
  }

  setGauge(name: string, value: number): void {
    this.gauges[name] = value;
  }
}
