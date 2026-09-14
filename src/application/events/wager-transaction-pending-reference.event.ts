import { IntegrationEvent } from "../../domain/messaging/integration-event";
import type { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction";
import type { EventContext } from "./event-context";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
}

/** Publicado quando a transação referenciada ainda não chegou. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: WagerTransactionPendingReferenceData;
  }) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: transaction.referenceExternalTransactionId as string,
      },
    });
  }
}
