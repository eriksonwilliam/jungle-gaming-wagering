import { Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateWallet } from "../../../application/use-cases/create-wallet.use-case";
import { GetWallet } from "../../../application/use-cases/get-wallet.use-case";
import { GetWalletLedger } from "../../../application/use-cases/get-wallet-ledger.use-case";
import { ReconcileWallet } from "../../../application/use-cases/reconcile-wallet.use-case";
import { CreateWalletDto } from "../dto/create-wallet.dto";
import { CorrelationId } from "../correlation-id.decorator";
import { presentLedgerEntry, presentWallet } from "../presenters/wallet.presenter";

const DEFAULT_LEDGER_PAGE_SIZE = 50;

@ApiTags("wallets")
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getWalletLedger: GetWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  async create(@Body() dto: CreateWalletDto, @CorrelationId() correlationId: string) {
    const { wallet } = await this.createWallet.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
      correlationId,
    });
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const wallet = await this.getWallet.execute(walletId);
    if (!wallet) {
      throw new NotFoundException({ error: "WALLET_NOT_FOUND", message: `wallet não encontrada: ${walletId}` });
    }
    return presentWallet(wallet);
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    const page = await this.getWalletLedger.execute({
      walletId,
      cursor,
      limit: limit ? Number(limit) : DEFAULT_LEDGER_PAGE_SIZE,
    });
    return { entries: page.entries.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(":walletId/reconciliation")
  async reconcile(@Param("walletId") walletId: string) {
    const result = await this.reconcileWallet.execute(walletId);
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}
