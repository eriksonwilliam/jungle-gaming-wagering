import { describe, expect, it } from "bun:test";
import { InboxMessage } from "../../../../src/domain/messaging/inbox-message";
import { Money } from "../../../../src/domain/money/money";
import { WagerTransactionKind, WagerTransactionStatus } from "../../../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import { ConsumeWagerTransactionMessage } from "../../../../src/application/use-cases/consume-wager-transaction-message.use-case";
import { SubmitWagerTransaction, type SubmitWagerTransactionInput } from "../../../../src/application/use-cases/submit-wager-transaction.use-case";
import {
  FakeClock,
  FakeIdGenerator,
  FakeMetrics,
  InMemoryInboxRepository,
  InMemoryLedgerRepository,
  InMemoryOutboxRepository,
  InMemoryWagerTransactionRepository,
  InMemoryWalletRepository,
  PassthroughUnitOfWork,
} from "../support/fakes";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function buildSut() {
  const walletRepository = new InMemoryWalletRepository();
  const wagerTransactionRepository = new InMemoryWagerTransactionRepository();
  const ledgerRepository = new InMemoryLedgerRepository();
  const outboxRepository = new InMemoryOutboxRepository();
  const inboxRepository = new InMemoryInboxRepository();
  const unitOfWork = new PassthroughUnitOfWork();
  const clock = new FakeClock(NOW);
  const submitWagerTransaction = new SubmitWagerTransaction(
    walletRepository,
    wagerTransactionRepository,
    ledgerRepository,
    outboxRepository,
    unitOfWork,
    clock,
    new FakeIdGenerator(),
    new FakeMetrics(),
  );
  const useCase = new ConsumeWagerTransactionMessage(inboxRepository, submitWagerTransaction, unitOfWork, clock);
  return { walletRepository, wagerTransactionRepository, inboxRepository, useCase };
}

function baseInput(overrides: Partial<SubmitWagerTransactionInput> = {}): SubmitWagerTransactionInput & { messageId: string } {
  return {
    messageId: "msg-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    correlationId: "corr-1",
    ...overrides,
  };
}

describe("ConsumeWagerTransactionMessage", () => {
  it("processa a mensagem e marca o inbox como processado", async () => {
    const { useCase, walletRepository, wagerTransactionRepository, inboxRepository } = buildSut();
    const wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: NOW });
    walletRepository.seed(wallet);

    const result = await useCase.execute(baseInput());

    expect(result.duplicateDelivery).toBe(false);
    expect(result.submitResult!.transaction.status).toBe(WagerTransactionStatus.Processed);
    const stored = await wagerTransactionRepository.findByIdempotencyKey("provider-a:ext-1");
    expect(stored!.status).toBe(WagerTransactionStatus.Processed);
    const inbox = await inboxRepository.findByConsumerAndMessageId("wager-transactions", "msg-1");
    expect(inbox!.isProcessed()).toBe(true);
  });

  it("mensagem já processada (redelivery) é ignorada sem reprocessar", async () => {
    const { useCase, walletRepository, wagerTransactionRepository } = buildSut();
    const wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: NOW });
    walletRepository.seed(wallet);

    await useCase.execute(baseInput());
    const replay = await useCase.execute(baseInput());

    expect(replay.duplicateDelivery).toBe(true);
    expect(replay.submitResult).toBeUndefined();
    const stored = await wagerTransactionRepository.findByIdempotencyKey("provider-a:ext-1");
    expect(stored!.status).toBe(WagerTransactionStatus.Processed);
    const finalWallet = await walletRepository.findById("wallet-1");
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
  });

  it("inbox recebido mas ainda não marcado como processado é reprocessado (crash entre commit e ack)", async () => {
    const { useCase, inboxRepository, walletRepository } = buildSut();
    const wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: NOW });
    walletRepository.seed(wallet);
    await inboxRepository.save(
      InboxMessage.receive({ messageId: "msg-1", consumerName: "wager-transactions", payloadHash: "hash-1", receivedAt: NOW }),
    );

    await useCase.execute(baseInput());

    const inbox = await inboxRepository.findByConsumerAndMessageId("wager-transactions", "msg-1");
    expect(inbox!.isProcessed()).toBe(true);
  });
});
