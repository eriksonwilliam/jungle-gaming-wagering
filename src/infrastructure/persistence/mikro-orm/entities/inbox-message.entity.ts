import { Entity, Property } from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageEntity {
  @Property({ fieldName: "consumer_name", primary: true })
  consumerName!: string;

  @Property({ fieldName: "message_id", primary: true })
  messageId!: string;

  @Property({ fieldName: "payload_hash" })
  payloadHash!: string;

  @Property({ fieldName: "received_at" })
  receivedAt!: Date;

  @Property({ fieldName: "processed_at", nullable: true })
  processedAt?: Date;
}
