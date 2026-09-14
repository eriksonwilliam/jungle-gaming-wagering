import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/domain/money/money";
import { LedgerDirection } from "../../../../src/domain/ledger/ledger-direction";
import { IllegalOperationError } from "../../../../src/domain/shared/illegal-operation.error";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "../../../../src/domain/wager-transaction/wager-transaction";
import {
  InvalidTransactionStateError,
  MissingReferenceError,
} from "../../../../src/domain/wager-transaction/wager-transaction.errors";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-01T00:05:00.000Z");
const MONEY = Money.from({ amount: "25.00", currency: "BRL" });

function baseProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: MONEY,
    createdAt: NOW,
    ...overrides,
  };
}

describe("WagerTransaction", () => {
  describe("create", () => {
    it("nasce PENDING", () => {
      const tx = WagerTransaction.create(baseProps());
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.isTerminal()).toBe(false);
    });

    it("aceita WIN sem referência", () => {
      const tx = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win }));
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
    });

    it("aceita WIN com referência opcional", () => {
      const tx = WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: "ext-0" }),
      );
      expect(tx.referenceExternalTransactionId).toBe("ext-0");
    });

    it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
      "exige referenceExternalTransactionId para %s",
      (kind) => {
        expect(() => WagerTransaction.create(baseProps({ kind }))).toThrow(MissingReferenceError);
      },
    );

    it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
      "aceita %s quando a referência é informada",
      (kind) => {
        const tx = WagerTransaction.create(baseProps({ kind, referenceExternalTransactionId: "ext-0" }));
        expect(tx.kind).toBe(kind);
      },
    );
  });

  describe("openingFor", () => {
    it("nasce PROCESSED e não exige referência", () => {
      const tx = WagerTransaction.openingFor({
        id: "wallet-1",
        providerId: "internal",
        walletId: "wallet-1",
        playerId: "player-1",
        money: MONEY,
        at: NOW,
      });
      expect(tx.kind).toBe(WagerTransactionKind.Opening);
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.processedAt).toEqual(NOW);
    });
  });

  describe("rehydrate", () => {
    it("reconstrói o estado exatamente como persistido, sem revalidar", () => {
      const tx = WagerTransaction.rehydrate({
        id: "tx-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        idempotencyKey: "provider-a:ext-1",
        payloadHash: "hash-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: MONEY,
        createdAt: NOW,
        status: WagerTransactionStatus.Processed,
        referenceTransactionId: "tx-0",
        processedAt: LATER,
      });
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.referenceTransactionId).toBe("tx-0");
      expect(tx.processedAt).toEqual(LATER);
    });
  });

  describe("transições", () => {
    it("markProcessed marca PROCESSED e registra referência e processedAt", () => {
      const tx = WagerTransaction.create(baseProps());
      tx.markProcessed("tx-ref", LATER);
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.referenceTransactionId).toBe("tx-ref");
      expect(tx.processedAt).toEqual(LATER);
      expect(tx.isTerminal()).toBe(true);
    });

    it("markPendingReference marca PENDING_REFERENCE", () => {
      const tx = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" }));
      tx.markPendingReference();
      expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
      expect(tx.isTerminal()).toBe(false);
    });

    it("reject marca REJECTED com failureCode", () => {
      const tx = WagerTransaction.create(baseProps());
      tx.reject("INSUFFICIENT_BALANCE");
      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe("INSUFFICIENT_BALANCE");
      expect(tx.isTerminal()).toBe(true);
    });

    it("fail marca FAILED com failureCode", () => {
      const tx = WagerTransaction.create(baseProps());
      tx.fail("INVALID_TRANSACTION_STATE");
      expect(tx.status).toBe(WagerTransactionStatus.Failed);
      expect(tx.failureCode).toBe("INVALID_TRANSACTION_STATE");
      expect(tx.isTerminal()).toBe(true);
    });

    it("PENDING_REFERENCE pode ser processada, rejeitada ou falhar em seguida", () => {
      const pendingRef = () => {
        const tx = WagerTransaction.create(
          baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" }),
        );
        tx.markPendingReference();
        return tx;
      };
      expect(() => pendingRef().markProcessed("tx-ref", LATER)).not.toThrow();
      expect(() => pendingRef().reject("REFERENCE_NOT_FOUND")).not.toThrow();
      expect(() => pendingRef().fail("REFERENCE_NOT_FOUND")).not.toThrow();
    });

    it.each([
      ["markProcessed", (tx: WagerTransaction) => tx.markProcessed(undefined, LATER)],
      ["markPendingReference", (tx: WagerTransaction) => tx.markPendingReference()],
      ["reject", (tx: WagerTransaction) => tx.reject("INSUFFICIENT_BALANCE")],
      ["fail", (tx: WagerTransaction) => tx.fail("INSUFFICIENT_BALANCE")],
    ] as const)("%s lança InvalidTransactionStateError a partir de um estado terminal", (_name, transition) => {
      const tx = WagerTransaction.create(baseProps());
      tx.markProcessed(undefined, LATER);
      expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
    });
  });

  describe("retry de PENDING_REFERENCE", () => {
    function pendingRefTx(): WagerTransaction {
      const tx = WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" }),
      );
      tx.markPendingReference();
      return tx;
    }

    it("isReferenceRetryDue é false para transações que não estão PENDING_REFERENCE", () => {
      const tx = WagerTransaction.create(baseProps());
      expect(tx.isReferenceRetryDue(NOW)).toBe(false);
    });

    it("isReferenceRetryDue é true antes da primeira tentativa (nextAttemptAt indefinido)", () => {
      expect(pendingRefTx().isReferenceRetryDue(NOW)).toBe(true);
    });

    it("scheduleReferenceRetry incrementa attempts e agenda backoff exponencial com teto", () => {
      const tx = pendingRefTx();

      tx.scheduleReferenceRetry(NOW);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.referenceNextAttemptAt!.getTime() - NOW.getTime()).toBe(60_000);
      expect(tx.isReferenceRetryDue(NOW)).toBe(false);
      expect(tx.isReferenceRetryDue(tx.referenceNextAttemptAt!)).toBe(true);

      tx.scheduleReferenceRetry(NOW);
      expect(tx.referenceAttempts).toBe(2);
      expect(tx.referenceNextAttemptAt!.getTime() - NOW.getTime()).toBe(240_000);

      for (let i = 0; i < 10; i += 1) {
        tx.scheduleReferenceRetry(NOW);
      }
      expect(tx.referenceNextAttemptAt!.getTime() - NOW.getTime()).toBe(4 * 60 * 60_000);
    });

    it("hasExhaustedReferenceRetries fica true a partir de MAX_REFERENCE_ATTEMPTS tentativas", () => {
      const tx = pendingRefTx();
      expect(tx.hasExhaustedReferenceRetries()).toBe(false);
      for (let i = 0; i < 8; i += 1) {
        tx.scheduleReferenceRetry(NOW);
      }
      expect(tx.hasExhaustedReferenceRetries()).toBe(true);
    });

    it("scheduleReferenceRetry lança InvalidTransactionStateError a partir de um estado terminal", () => {
      const tx = WagerTransaction.create(baseProps());
      tx.reject("INSUFFICIENT_BALANCE");
      expect(() => tx.scheduleReferenceRetry(NOW)).toThrow(InvalidTransactionStateError);
    });

    it("rehydrate preserva referenceAttempts e referenceNextAttemptAt", () => {
      const tx = WagerTransaction.rehydrate({
        id: "tx-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        idempotencyKey: "provider-a:ext-1",
        payloadHash: "hash-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: MONEY,
        createdAt: NOW,
        status: WagerTransactionStatus.PendingReference,
        referenceAttempts: 3,
        referenceNextAttemptAt: LATER,
      });
      expect(tx.referenceAttempts).toBe(3);
      expect(tx.referenceNextAttemptAt).toEqual(LATER);
    });

    it("rehydrate assume referenceAttempts 0 quando omitido", () => {
      const tx = WagerTransaction.rehydrate({
        id: "tx-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        idempotencyKey: "provider-a:ext-1",
        payloadHash: "hash-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: MONEY,
        createdAt: NOW,
        status: WagerTransactionStatus.PendingReference,
      });
      expect(tx.referenceAttempts).toBe(0);
    });
  });

  describe("consultas de domínio", () => {
    it("affectsBalance é false apenas para LOSS", () => {
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet })).affectsBalance()).toBe(true);
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win })).affectsBalance()).toBe(true);
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss })).affectsBalance()).toBe(false);
      expect(
        WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" })).affectsBalance(),
      ).toBe(true);
      expect(
        WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "e" })).affectsBalance(),
      ).toBe(true);
    });

    it("requiresReference é true apenas para REFUND e ROLLBACK", () => {
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet })).requiresReference()).toBe(false);
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win })).requiresReference()).toBe(false);
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss })).requiresReference()).toBe(false);
      expect(
        WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" })).requiresReference(),
      ).toBe(true);
      expect(
        WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "e" })).requiresReference(),
      ).toBe(true);
    });

    it("matchesPayload compara o hash armazenado", () => {
      const tx = WagerTransaction.create(baseProps({ payloadHash: "abc" }));
      expect(tx.matchesPayload("abc")).toBe(true);
      expect(tx.matchesPayload("xyz")).toBe(false);
    });
  });

  describe("ledgerDirectionFor", () => {
    it("OPENING e WIN e REFUND são CREDIT", () => {
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win })).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );
      expect(
        WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" })).ledgerDirectionFor(),
      ).toBe(LedgerDirection.Credit);
      expect(
        WagerTransaction.openingFor({
          id: "w",
          providerId: "internal",
          walletId: "w",
          playerId: "p",
          money: MONEY,
          at: NOW,
        }).ledgerDirectionFor(),
      ).toBe(LedgerDirection.Credit);
    });

    it("BET é DEBIT", () => {
      expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet })).ledgerDirectionFor()).toBe(
        LedgerDirection.Debit,
      );
    });

    it("ROLLBACK inverte a direção da referência: reverte um BET (débito) com crédito", () => {
      const bet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
      const rollback = WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-1" }),
      );
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    });

    it("ROLLBACK inverte a direção da referência: reverte um WIN (crédito) com débito", () => {
      const win = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win }));
      const rollback = WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-1" }),
      );
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    });

    it("ROLLBACK sem referência lança IllegalOperationError", () => {
      const rollback = WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-1" }),
      );
      expect(() => rollback.ledgerDirectionFor()).toThrow(IllegalOperationError);
    });

    it("LOSS lança IllegalOperationError", () => {
      const loss = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss }));
      expect(() => loss.ledgerDirectionFor()).toThrow(IllegalOperationError);
    });
  });
});
