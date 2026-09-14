import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { canonicalJsonHash } from "../../../application/use-cases/support/canonical-hash";
import { GetWagerTransaction } from "../../../application/use-cases/get-wager-transaction.use-case";
import { SubmitWagerTransaction } from "../../../application/use-cases/submit-wager-transaction.use-case";
import { WagerTransactionKind } from "../../../domain/wager-transaction/wager-transaction";
import { CorrelationId } from "../correlation-id.decorator";
import { SubmitWagerTransactionDto } from "../dto/submit-wager-transaction.dto";
import { presentWagerTransaction } from "../presenters/wager-transaction.presenter";
import { statusForSubmitResult } from "../presenters/submit-result-status";

@ApiTags("wagering")
@Controller()
export class WageringController {
  constructor(
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    private readonly getWagerTransaction: GetWagerTransaction,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({ error: "IDEMPOTENCY_KEY_REQUIRED", message: "header Idempotency-Key é obrigatório" });
    }
    if (dto.kind === WagerTransactionKind.Opening) {
      throw new BadRequestException({ error: "INVALID_KIND", message: "OPENING é interno e não pode ser submetido" });
    }

    const payloadHash = canonicalJsonHash({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: { amount: dto.money.amount, currency: dto.money.currency },
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });

    const result = await this.submitWagerTransaction.execute({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      payloadHash,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      correlationId,
    });

    res.status(statusForSubmitResult(result));
    return {
      transactionId: result.transaction.id,
      status: result.transaction.status,
      balance: result.wallet?.balance.toJSON(),
      failureCode: result.transaction.failureCode,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    const transaction = await this.getWagerTransaction.byId(transactionId);
    if (!transaction) {
      throw new NotFoundException({ error: "TRANSACTION_NOT_FOUND", message: `transação não encontrada: ${transactionId}` });
    }
    return presentWagerTransaction(transaction);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProviderAndExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const transaction = await this.getWagerTransaction.byProviderAndExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new NotFoundException({
        error: "TRANSACTION_NOT_FOUND",
        message: `transação não encontrada: ${providerId}/${externalTransactionId}`,
      });
    }
    return presentWagerTransaction(transaction);
  }
}
