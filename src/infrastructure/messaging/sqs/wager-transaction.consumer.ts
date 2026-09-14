import { DeleteMessageCommand, ReceiveMessageCommand, type Message, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { IdempotencyConflictError } from "../../../application/errors/idempotency-conflict.error";
import type { Logger } from "../../../application/ports/logger.port";
import type { Metrics } from "../../../application/ports/metrics.port";
import { ConsumeWagerTransactionMessage } from "../../../application/use-cases/consume-wager-transaction-message.use-case";
import { canonicalJsonHash } from "../../../application/use-cases/support/canonical-hash";
import type { MoneyProps } from "../../../domain/money/money";
import { DomainError } from "../../../domain/shared/domain-error";
import { WagerTransactionKind } from "../../../domain/wager-transaction/wager-transaction";
import { runInDbContext } from "../../persistence/mikro-orm/run-in-context";

const VALID_KINDS: ReadonlySet<string> = new Set(
  Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening),
);

interface WagerTransactionRequestedMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

/**
 * Consome `wager-transactions.fifo`. Reusa `ConsumeWagerTransactionMessage`
 * (mesmo use case do HTTP). Erro de negócio → ack (reenviar não ajudaria);
 * erro transitório → não faz ack, deixa a visibilidade expirar para retry;
 * esgotado o `maxReceiveCount`, o redrive policy da fila move para a DLQ.
 * Em `onModuleDestroy` (SIGTERM), para de puxar mensagens novas mas deixa a
 * mensagem em andamento terminar antes de encerrar.
 */
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly orm: MikroORM,
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly consumeWagerTransactionMessage: ConsumeWagerTransactionMessage,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    /** Configuráveis para permitir testes rápidos de retry/DLQ; produção usa os defaults. */
    private readonly visibilityTimeoutSeconds = 30,
    private readonly waitTimeSeconds = 5,
  ) {}

  onModuleInit(): void {
    this.running = true;
    this.loopPromise = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error("sqs_poll_failed", { message: error instanceof Error ? error.message : String(error) });
        await sleep(1000);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.waitTimeSeconds,
        VisibilityTimeout: this.visibilityTimeoutSeconds,
      }),
    );
    for (const message of response.Messages ?? []) {
      if (!this.running) {
        return;
      }
      await this.handleMessage(message);
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) {
      return;
    }

    let parsed: WagerTransactionRequestedMessage;
    try {
      parsed = JSON.parse(message.Body) as WagerTransactionRequestedMessage;
    } catch {
      this.logger.error("sqs_message_invalid_json", { messageId: message.MessageId });
      await this.ack(message);
      return;
    }

    if (!VALID_KINDS.has(parsed.data.kind)) {
      this.logger.error("sqs_message_invalid_kind", { messageId: parsed.messageId, kind: parsed.data.kind });
      await this.ack(message);
      return;
    }

    const payloadHash = canonicalJsonHash(parsed.data);
    const startedAt = performance.now();

    try {
      const result = await runInDbContext(this.orm, () =>
        this.consumeWagerTransactionMessage.execute({
          messageId: parsed.messageId,
          providerId: parsed.data.providerId,
          externalTransactionId: parsed.data.externalTransactionId,
          idempotencyKey: parsed.data.idempotencyKey,
          payloadHash,
          playerId: parsed.data.playerId,
          walletId: parsed.data.walletId,
          roundId: parsed.data.roundId,
          gameId: parsed.data.gameId,
          kind: parsed.data.kind as Exclude<WagerTransactionKind, WagerTransactionKind.Opening>,
          money: parsed.data.money,
          referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
          correlationId: parsed.messageId,
        }),
      );
      await this.ack(message);
      this.metrics.observeHistogram("wager_transaction_processing_duration_ms", performance.now() - startedAt, { channel: "sqs" });
      this.metrics.incrementCounter("wager_transactions_consumed_total", { outcome: "ok" });
      if (result.duplicateDelivery) {
        this.metrics.incrementCounter("wager_transactions_duplicate_deliveries_total");
      } else {
        this.metrics.incrementCounter("wager_transactions_total", { channel: "sqs", status: result.submitResult!.transaction.status });
        if (result.submitResult!.idempotentReplay) {
          this.metrics.incrementCounter("wager_transactions_replays_total", { channel: "sqs" });
        }
      }
    } catch (error) {
      if (error instanceof DomainError || error instanceof IdempotencyConflictError) {
        this.logger.warn("sqs_message_business_error", { messageId: parsed.messageId, error: error.message });
        await this.ack(message);
        this.metrics.incrementCounter("wager_transactions_consumed_total", { outcome: "business_error" });
        return;
      }
      this.logger.error("sqs_message_transient_error", {
        messageId: parsed.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.metrics.incrementCounter("wager_transactions_consumed_total", { outcome: "transient_error" });
      this.metrics.incrementCounter("wager_transactions_retries_total", { reason: "transient_error" });
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle as string }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
