import { IntegrationEvent } from "../../domain/messaging/integration-event";
import type { MoneyProps } from "../../domain/money/money";
import type { FailureCode } from "../../domain/wager-transaction/failure-code";
import type { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction";
import type { EventContext } from "./event-context";

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

/** Publicado para toda transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: WagerTransactionRejectedData;
  }) {
    super(props);
  }

  static from(transaction: WagerTransaction, failureCode: FailureCode, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode,
      },
    });
  }
}
