import { HttpStatus } from "@nestjs/common";
import { WagerTransactionStatus } from "../../../domain/wager-transaction/wager-transaction";
import type { SubmitWagerTransactionResult } from "../../../application/use-cases/submit-wager-transaction.use-case";

/** Mapeamento HTTP da seção 8 do ARCHITECTURE.md — cada status pede uma reação diferente do provedor. */
export function statusForSubmitResult(result: SubmitWagerTransactionResult): number {
  if (result.idempotentReplay) {
    return HttpStatus.OK;
  }
  switch (result.transaction.status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      return HttpStatus.SERVICE_UNAVAILABLE;
    case WagerTransactionStatus.Pending:
      return HttpStatus.CREATED;
  }
}
