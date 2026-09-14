import type { InboxMessage } from "../../domain/messaging/inbox-message";

export interface InboxRepository {
  findByConsumerAndMessageId(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;

  save(message: InboxMessage): Promise<void>;
}
