import { DomainError } from "../shared/domain-error";
import type { Money } from "../money/money";

/**
 * Saldo insuficiente para debitar `requested`. O use case decide qual
 * failureCode expor (INSUFFICIENT_BALANCE para BET,
 * REVERSAL_INSUFFICIENT_BALANCE para ROLLBACK/REFUND) — o domínio só
 * garante que o saldo nunca fica negativo.
 */
export class InsufficientBalanceError extends DomainError {
  readonly code = "INSUFFICIENT_BALANCE";

  constructor(
    public readonly walletId: string,
    public readonly requested: Money,
    public readonly available: Money,
  ) {
    super(
      `saldo insuficiente na wallet ${walletId}: requisitado ${requested.toString()}, disponível ${available.toString()}`,
    );
  }
}
