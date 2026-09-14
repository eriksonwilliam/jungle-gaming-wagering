import { describe, expect, it } from "bun:test";
import { Money } from "../../../../../src/domain/money/money";
import { WagerTransaction, WagerTransactionKind } from "../../../../../src/domain/wager-transaction/wager-transaction";
import { validateReferenceMatch } from "../../../../../src/application/use-cases/support/validate-reference";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const MONEY = Money.from({ amount: "30.00", currency: "BRL" });

function bet(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  const tx = WagerTransaction.create({
    id: "bet-1",
    providerId: "provider-a",
    externalTransactionId: "bet-1",
    idempotencyKey: "provider-a:bet-1",
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: MONEY,
    createdAt: NOW,
    ...overrides,
  });
  return tx;
}

function refund(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: "refund-1",
    providerId: "provider-a",
    externalTransactionId: "refund-1",
    idempotencyKey: "provider-a:refund-1",
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Refund,
    money: MONEY,
    referenceExternalTransactionId: "bet-1",
    createdAt: NOW,
    ...overrides,
  });
}

describe("validateReferenceMatch", () => {
  it("aceita uma referência PROCESSED compatível", () => {
    const reference = bet();
    reference.markProcessed(undefined, NOW);
    expect(validateReferenceMatch(refund(), reference)).toBeUndefined();
  });

  it("rejeita quando o player diverge", () => {
    const reference = bet({ playerId: "outro-player" });
    reference.markProcessed(undefined, NOW);
    expect(validateReferenceMatch(refund(), reference)).toBe("REFERENCE_MISMATCH");
  });

  it("rejeita quando a wallet diverge", () => {
    const reference = bet({ walletId: "outra-wallet" });
    reference.markProcessed(undefined, NOW);
    expect(validateReferenceMatch(refund(), reference)).toBe("REFERENCE_MISMATCH");
  });

  it("rejeita quando a rodada diverge", () => {
    const reference = bet({ roundId: "outra-rodada" });
    reference.markProcessed(undefined, NOW);
    expect(validateReferenceMatch(refund(), reference)).toBe("REFERENCE_MISMATCH");
  });

  it("rejeita quando a referência não está PROCESSED", () => {
    const reference = bet();
    expect(validateReferenceMatch(refund(), reference)).toBe("REFERENCE_MISMATCH");
  });

  it("rejeita REFUND referenciando algo que não é BET", () => {
    const reference = WagerTransaction.create({
      id: "win-1",
      providerId: "provider-a",
      externalTransactionId: "win-1",
      idempotencyKey: "provider-a:win-1",
      payloadHash: "hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Win,
      money: MONEY,
      createdAt: NOW,
    });
    reference.markProcessed(undefined, NOW);
    expect(validateReferenceMatch(refund({ referenceExternalTransactionId: "win-1" }), reference)).toBe("REFERENCE_MISMATCH");
  });

  it("rejeita quando o valor diverge da referência", () => {
    const reference = bet();
    reference.markProcessed(undefined, NOW);
    const mismatched = refund({ money: Money.from({ amount: "999.00", currency: "BRL" }) });
    expect(validateReferenceMatch(mismatched, reference)).toBe("REFERENCE_MISMATCH");
  });

  it("ROLLBACK aceita referenciar BET, WIN ou REFUND", () => {
    for (const kind of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund] as const) {
      const reference = WagerTransaction.create({
        id: `ref-${kind}`,
        providerId: "provider-a",
        externalTransactionId: `ref-${kind}`,
        idempotencyKey: `provider-a:ref-${kind}`,
        payloadHash: "hash",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind,
        money: MONEY,
        referenceExternalTransactionId: kind === WagerTransactionKind.Refund ? "bet-1" : undefined,
        createdAt: NOW,
      });
      reference.markProcessed(undefined, NOW);
      const rollback = WagerTransaction.create({
        id: "rollback-1",
        providerId: "provider-a",
        externalTransactionId: "rollback-1",
        idempotencyKey: "provider-a:rollback-1",
        payloadHash: "hash",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Rollback,
        money: MONEY,
        referenceExternalTransactionId: `ref-${kind}`,
        createdAt: NOW,
      });
      expect(validateReferenceMatch(rollback, reference)).toBeUndefined();
    }
  });
});
