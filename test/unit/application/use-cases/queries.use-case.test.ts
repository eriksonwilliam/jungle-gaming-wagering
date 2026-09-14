import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/domain/money/money";
import { WagerTransaction, WagerTransactionKind } from "../../../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../../../src/domain/wallet/wallet";
import { GetWallet } from "../../../../src/application/use-cases/get-wallet.use-case";
import { GetWalletLedger } from "../../../../src/application/use-cases/get-wallet-ledger.use-case";
import { GetWagerTransaction } from "../../../../src/application/use-cases/get-wager-transaction.use-case";
import { InMemoryLedgerRepository, InMemoryWagerTransactionRepository, InMemoryWalletRepository } from "../support/fakes";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("GetWallet", () => {
  it("retorna a wallet quando existe", async () => {
    const repo = new InMemoryWalletRepository();
    const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: Money.zero("BRL"), now: NOW });
    repo.seed(wallet);
    expect(await new GetWallet(repo).execute("w1")).toBe(wallet);
  });

  it("retorna undefined quando não existe", async () => {
    const repo = new InMemoryWalletRepository();
    expect(await new GetWallet(repo).execute("nope")).toBeUndefined();
  });
});

describe("GetWalletLedger", () => {
  it("delega ao repositório com cursor e limite", async () => {
    const repo = new InMemoryLedgerRepository();
    const page = await new GetWalletLedger(repo).execute({ walletId: "w1", cursor: undefined, limit: 10 });
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("GetWagerTransaction", () => {
  it("busca por id", async () => {
    const repo = new InMemoryWagerTransactionRepository();
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "hash",
      walletId: "w1",
      playerId: "p1",
      roundId: "r1",
      gameId: "g1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      createdAt: NOW,
    });
    repo.seed(tx);
    const useCase = new GetWagerTransaction(repo);
    expect(await useCase.byId("tx-1")).toBe(tx);
    expect(await useCase.byId("nope")).toBeUndefined();
    expect(await useCase.byProviderAndExternalId("provider-a", "ext-1")).toBe(tx);
    expect(await useCase.byProviderAndExternalId("provider-a", "nope")).toBeUndefined();
  });
});
