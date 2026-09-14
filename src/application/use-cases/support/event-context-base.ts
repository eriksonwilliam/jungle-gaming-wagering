export interface EventContextBase {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}
