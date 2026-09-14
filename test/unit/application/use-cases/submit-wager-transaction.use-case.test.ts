import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/domain/money/money";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import { IdempotencyConflictError } from "../../../../src/application/errors/idempotency-conflict.error";
import { IdempotencyRaceLostError } from "../../../../src/application/errors/idempotency-race-lost.error";
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionInput,
} from "../../../../src/application/use-cases/submit-wager-transaction.use-case";
import {
  FakeClock,
  FakeIdGenerator,
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
  const clock = new FakeClock(NOW);
  const idGenerator = new FakeIdGenerator();
  const useCase = new SubmitWagerTransaction(
    walletRepository,
    wagerTransactionRepository,
    ledgerRepository,
    outboxRepository,
    new PassthroughUnitOfWork(),
    clock,
    idGenerator,
  );
  return { walletRepository, wagerTransactionRepository, ledgerRepository, outboxRepository, clock, idGenerator, useCase };
}

function baseInput(overrides: Partial<SubmitWagerTransactionInput> = {}): SubmitWagerTransactionInput {
  return {
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

function seedWallet(walletRepository: InMemoryWalletRepository, balance = "100.00"): Wallet {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
    now: NOW,
  });
  walletRepository.seed(wallet);
  return wallet;
}

describe("SubmitWagerTransaction", () => {
  it("processa um BET com saldo suficiente, debitando a wallet", async () => {
    const { useCase, walletRepository, ledgerRepository, outboxRepository } = buildSut();
    seedWallet(walletRepository, "100.00");

    const result = await useCase.execute(baseInput());

    expect(result.idempotentReplay).toBe(false);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.wallet!.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
    expect(ledgerRepository.entries).toHaveLength(1);
    expect(outboxRepository.messages.some((m) => m.eventType === "WagerTransactionProcessed")).toBe(true);
    expect(outboxRepository.messages.some((m) => m.eventType === "WalletBalanceChanged")).toBe(true);
  });

  it("rejeita BET com saldo insuficiente com failureCode INSUFFICIENT_BALANCE", async () => {
    const { useCase, walletRepository, outboxRepository } = buildSut();
    seedWallet(walletRepository, "10.00");

    const result = await useCase.execute(baseInput({ money: { amount: "25.00", currency: "BRL" } }));

    expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.transaction.failureCode).toBe("INSUFFICIENT_BALANCE");
    expect(outboxRepository.messages.some((m) => m.eventType === "WagerTransactionRejected")).toBe(true);
  });

  it("cenário obrigatório: duas apostas de 80 contra saldo de 100 — uma processa, a outra rejeita, saldo final 20", async () => {
    const { useCase, walletRepository, ledgerRepository } = buildSut();
    seedWallet(walletRepository, "100.00");

    const first = await useCase.execute(
      baseInput({ externalTransactionId: "ext-1", idempotencyKey: "provider-a:ext-1", money: { amount: "80.00", currency: "BRL" } }),
    );
    const second = await useCase.execute(
      baseInput({ externalTransactionId: "ext-2", idempotencyKey: "provider-a:ext-2", money: { amount: "80.00", currency: "BRL" } }),
    );

    const statuses = [first.transaction.status, second.transaction.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());
    const finalWallet = await walletRepository.findById("wallet-1");
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "20.00", currency: "BRL" });
    expect(ledgerRepository.entries).toHaveLength(1);
  });

  it("rejeita CURRENCY_MISMATCH quando a moeda da operação diverge da wallet", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");

    const result = await useCase.execute(baseInput({ money: { amount: "10.00", currency: "USD" } }));

    expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.transaction.failureCode).toBe("CURRENCY_MISMATCH");
  });

  it("rejeita WALLET_NOT_FOUND quando a wallet não existe", async () => {
    const { useCase } = buildSut();

    const result = await useCase.execute(baseInput());

    expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.transaction.failureCode).toBe("WALLET_NOT_FOUND");
  });

  it("processa LOSS sem tocar a wallet nem gerar lançamento", async () => {
    const { useCase, walletRepository, ledgerRepository, outboxRepository } = buildSut();
    const wallet = seedWallet(walletRepository, "100.00");

    const result = await useCase.execute(baseInput({ kind: WagerTransactionKind.Loss }));

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.wallet).toBeUndefined();
    expect(ledgerRepository.entries).toHaveLength(0);
    const stored = await walletRepository.findById(wallet.id);
    expect(stored!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(outboxRepository.messages.some((m) => m.eventType === "WagerTransactionProcessed")).toBe(true);
  });

  it("processa WIN creditando a wallet", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");

    const result = await useCase.execute(baseInput({ kind: WagerTransactionKind.Win, money: { amount: "50.00", currency: "BRL" } }));

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.wallet!.balance.toJSON()).toEqual({ amount: "150.00", currency: "BRL" });
  });

  it("WIN com referência opcional resolvida anexa referenceTransactionId sem bloquear", async () => {
    const { useCase, walletRepository, wagerTransactionRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    const bet = await useCase.execute(
      baseInput({ kind: WagerTransactionKind.Bet, externalTransactionId: "bet-1", idempotencyKey: "provider-a:bet-1", money: { amount: "20.00", currency: "BRL" } }),
    );

    const win = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Win,
        externalTransactionId: "win-1",
        idempotencyKey: "provider-a:win-1",
        referenceExternalTransactionId: "bet-1",
        money: { amount: "40.00", currency: "BRL" },
      }),
    );

    expect(win.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect((await wagerTransactionRepository.findById(win.transaction.id))!.status).toBe(WagerTransactionStatus.Processed);
  });

  it("WIN com referência opcional inexistente processa normalmente, sem referenceTransactionId", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");

    const result = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: "nao-existe",
        money: { amount: "40.00", currency: "BRL" },
      }),
    );

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.transaction.referenceTransactionId).toBeUndefined();
  });

  it("REFUND sem a referência ainda entregue persiste PENDING_REFERENCE e publica o evento", async () => {
    const { useCase, outboxRepository } = buildSut();

    const result = await useCase.execute(
      baseInput({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-x" }),
    );

    expect(result.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(outboxRepository.messages.some((m) => m.eventType === "WagerTransactionPendingReference")).toBe(true);
  });

  it("REFUND credita a wallet revertendo uma BET PROCESSED", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    const bet = await useCase.execute(
      baseInput({ externalTransactionId: "bet-1", idempotencyKey: "provider-a:bet-1", money: { amount: "30.00", currency: "BRL" } }),
    );
    expect(bet.transaction.status).toBe(WagerTransactionStatus.Processed);

    const refund = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: "refund-1",
        idempotencyKey: "provider-a:refund-1",
        referenceExternalTransactionId: "bet-1",
        money: { amount: "30.00", currency: "BRL" },
      }),
    );

    expect(refund.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.wallet!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("REFUND duplicado da mesma BET é rejeitado com REFERENCE_ALREADY_REVERSED", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    await useCase.execute(baseInput({ externalTransactionId: "bet-1", idempotencyKey: "provider-a:bet-1", money: { amount: "30.00", currency: "BRL" } }));
    await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: "refund-1",
        idempotencyKey: "provider-a:refund-1",
        referenceExternalTransactionId: "bet-1",
        money: { amount: "30.00", currency: "BRL" },
      }),
    );

    const secondRefund = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: "refund-2",
        idempotencyKey: "provider-a:refund-2",
        referenceExternalTransactionId: "bet-1",
        money: { amount: "30.00", currency: "BRL" },
      }),
    );

    expect(secondRefund.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(secondRefund.transaction.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
  });

  it("REFUND com valor diferente da referência é rejeitado com REFERENCE_MISMATCH", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    await useCase.execute(baseInput({ externalTransactionId: "bet-1", idempotencyKey: "provider-a:bet-1", money: { amount: "30.00", currency: "BRL" } }));

    const refund = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: "refund-1",
        idempotencyKey: "provider-a:refund-1",
        referenceExternalTransactionId: "bet-1",
        money: { amount: "999.00", currency: "BRL" },
      }),
    );

    expect(refund.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.transaction.failureCode).toBe("REFERENCE_MISMATCH");
  });

  it("ROLLBACK de um BET credita de volta o valor debitado", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    await useCase.execute(baseInput({ externalTransactionId: "bet-1", idempotencyKey: "provider-a:bet-1", money: { amount: "30.00", currency: "BRL" } }));

    const rollback = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: "rollback-1",
        idempotencyKey: "provider-a:rollback-1",
        referenceExternalTransactionId: "bet-1",
        money: { amount: "30.00", currency: "BRL" },
      }),
    );

    expect(rollback.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.wallet!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("ROLLBACK de um WIN debita de volta o valor creditado, rejeitando se ficaria negativo", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "10.00");
    await useCase.execute(
      baseInput({ kind: WagerTransactionKind.Win, externalTransactionId: "win-1", idempotencyKey: "provider-a:win-1", money: { amount: "50.00", currency: "BRL" } }),
    );
    // saldo agora é 60.00

    const rollback = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: "rollback-1",
        idempotencyKey: "provider-a:rollback-1",
        referenceExternalTransactionId: "win-1",
        money: { amount: "50.00", currency: "BRL" },
      }),
    );

    expect(rollback.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.wallet!.balance.toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
  });

  it("ROLLBACK que deixaria saldo negativo é rejeitado com REVERSAL_INSUFFICIENT_BALANCE", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "10.00");
    await useCase.execute(
      baseInput({ kind: WagerTransactionKind.Win, externalTransactionId: "win-1", idempotencyKey: "provider-a:win-1", money: { amount: "50.00", currency: "BRL" } }),
    );
    // saldo = 60.00 — gasta parte dele antes do rollback chegar
    await useCase.execute(
      baseInput({ externalTransactionId: "bet-1", idempotencyKey: "provider-a:bet-1", money: { amount: "55.00", currency: "BRL" } }),
    );
    // saldo = 5.00, rollback do WIN de 50 deixaria -45

    const rollback = await useCase.execute(
      baseInput({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: "rollback-1",
        idempotencyKey: "provider-a:rollback-1",
        referenceExternalTransactionId: "win-1",
        money: { amount: "50.00", currency: "BRL" },
      }),
    );

    expect(rollback.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.transaction.failureCode).toBe("REVERSAL_INSUFFICIENT_BALANCE");
  });

  it("replay idempotente retorna o resultado original sem reprocessar", async () => {
    const { useCase, walletRepository, ledgerRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    const input = baseInput({ money: { amount: "25.00", currency: "BRL" } });

    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(second.wallet!.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
    expect(ledgerRepository.entries).toHaveLength(1);
  });

  it("idempotency key repetida com payload diferente lança IdempotencyConflictError", async () => {
    const { useCase, walletRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    await useCase.execute(baseInput({ payloadHash: "hash-1" }));

    await expect(useCase.execute(baseInput({ payloadHash: "hash-2" }))).rejects.toThrow(IdempotencyConflictError);
  });

  it("propaga erros inesperados durante o débito/crédito em vez de mascarar como rejeição", async () => {
    const { useCase, walletRepository } = buildSut();
    const wallet = seedWallet(walletRepository, "100.00");
    wallet.debit = () => {
      throw new Error("falha inesperada de infraestrutura");
    };

    await expect(useCase.execute(baseInput())).rejects.toThrow("falha inesperada de infraestrutura");
  });

  it("perde a corrida de idempotência (INSERT concorrente) e devolve o resultado da vencedora como replay", async () => {
    const { useCase, walletRepository, wagerTransactionRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    const input = baseInput({ money: { amount: "25.00", currency: "BRL" }, payloadHash: "hash-race" });

    // A "vencedora" já processou e commitou fora de banda (outra instância).
    const winner = WagerTransaction.create({
      id: "winner-tx",
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: Money.from(input.money),
      createdAt: NOW,
    });
    winner.markProcessed(undefined, NOW);
    wagerTransactionRepository.seed(winner);

    // Mas a checagem inicial desta requisição não a viu — corrida real: as
    // duas checaram antes de qualquer commit ficar visível.
    let firstCall = true;
    const originalFind = wagerTransactionRepository.findByIdempotencyKey.bind(wagerTransactionRepository);
    wagerTransactionRepository.findByIdempotencyKey = async (key: string) => {
      if (firstCall) {
        firstCall = false;
        return undefined;
      }
      return originalFind(key);
    };
    wagerTransactionRepository.failNextSaveWith = new IdempotencyRaceLostError(input.idempotencyKey);

    const result = await useCase.execute(input);

    expect(result.idempotentReplay).toBe(true);
    expect(result.transaction.id).toBe(winner.id);
  });

  it("propaga a corrida de idempotência quando a vencedora não é encontrada", async () => {
    const { useCase, walletRepository, wagerTransactionRepository } = buildSut();
    seedWallet(walletRepository, "100.00");
    wagerTransactionRepository.failNextSaveWith = new IdempotencyRaceLostError("provider-a:ext-1");

    await expect(useCase.execute(baseInput())).rejects.toThrow(IdempotencyRaceLostError);
  });

  it("replay de uma transação que não afeta saldo (LOSS) não busca wallet", async () => {
    const { useCase } = buildSut();
    const input = baseInput({ kind: WagerTransactionKind.Loss });

    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(second.idempotentReplay).toBe(true);
    expect(second.wallet).toBeUndefined();
    expect(second.transaction.id).toBe(first.transaction.id);
  });
});
