import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "outbox_messages" })
@Index({ properties: ["publishedAt", "nextAttemptAt"], name: "outbox_pending_idx" })
export class OutboxMessageEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "aggregate_id" })
  aggregateId!: string;

  @Property({ fieldName: "event_type" })
  eventType!: string;

  @Property({ type: "json" })
  payload!: Record<string, unknown>;

  @Property({ fieldName: "occurred_at" })
  occurredAt!: Date;

  @Property()
  attempts: number = 0;

  @Property({ fieldName: "next_attempt_at", nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: "published_at", nullable: true })
  publishedAt?: Date;
}
