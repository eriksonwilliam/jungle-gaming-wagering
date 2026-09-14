import { InboxMessage } from "../../domain/messaging/inbox-message";
import type { Clock } from "../ports/clock.port";
import type { InboxRepository } from "../ports/inbox-repository.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { SubmitWagerTransaction, SubmitWagerTransactionInput } from "./submit-wager-transaction.use-case";

const CONSUMER_NAME = "wager-transactions";

export interface ConsumeWagerTransactionMessageInput extends SubmitWagerTransactionInput {
  messageId: string;
}

/**
 * Entrada SQS: dedup persistente por (consumerName, messageId) e reusa
 * exatamente o mesmo `SubmitWagerTransaction` da entrada HTTP. Inbox e os
 * efeitos financeiros participam da mesma transação — `unitOfWork.run`
 * aninhado aqui e dentro de `SubmitWagerTransaction.execute` reaproveita a
 * transação já aberta (MikroORM não inicia uma segunda).
 */
export class ConsumeWagerTransactionMessage {
  constructor(
    private readonly inboxRepository: InboxRepository,
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: ConsumeWagerTransactionMessageInput): Promise<void> {
    const existing = await this.inboxRepository.findByConsumerAndMessageId(CONSUMER_NAME, input.messageId);
    if (existing?.isProcessed()) {
      return;
    }

    await this.unitOfWork.run(async () => {
      const inbox =
        existing ??
        InboxMessage.receive({
          messageId: input.messageId,
          consumerName: CONSUMER_NAME,
          payloadHash: input.payloadHash,
          receivedAt: this.clock.now(),
        });

      await this.submitWagerTransaction.execute(input);

      inbox.markProcessed(this.clock.now());
      await this.inboxRepository.save(inbox);
    });
  }
}
