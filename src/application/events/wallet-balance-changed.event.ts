import { IntegrationEvent } from "../../domain/messaging/integration-event";
import type { MoneyProps } from "../../domain/money/money";
import type { LedgerDirection } from "../../domain/ledger/ledger-direction";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { Wallet } from "../../domain/wallet/wallet";
import type { EventContext } from "./event-context";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Publicado somente quando o saldo da wallet muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(props: {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: WalletBalanceChangedData;
  }) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
