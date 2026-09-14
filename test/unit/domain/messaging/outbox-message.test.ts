import { describe, expect, it } from "bun:test";
import { IntegrationEvent, type IntegrationEventProps } from "../../../../src/domain/messaging/integration-event";
import { OutboxMessage } from "../../../../src/domain/messaging/outbox-message";

const NOW = new Date("2026-01-01T00:00:00.000Z");

interface TestEventData {
  foo: string;
}

class TestEvent extends IntegrationEvent<TestEventData> {
  readonly eventType = "TestEvent";
  readonly version = 1;

  constructor(props: IntegrationEventProps<TestEventData>) {
    super(props);
  }
}

function buildEvent(): TestEvent {
  return new TestEvent({
    eventId: "event-1",
    aggregateId: "aggregate-1",
    correlationId: "corr-1",
    occurredAt: NOW,
    data: { foo: "bar" },
  });
}

describe("OutboxMessage", () => {
  it("enqueue nasce pendente, com attempts zero e payload do envelope do evento", () => {
    const message = OutboxMessage.enqueue("outbox-1", buildEvent());
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.aggregateId).toBe("aggregate-1");
    expect(message.eventType).toBe("TestEvent");
    expect(message.payload).toEqual({
      eventId: "event-1",
      eventType: "TestEvent",
      aggregateId: "aggregate-1",
      correlationId: "corr-1",
      causationId: undefined,
      occurredAt: NOW.toISOString(),
      version: 1,
      data: { foo: "bar" },
    });
  });

  it("isDue é true imediatamente após enqueue (nunca tentada)", () => {
    const message = OutboxMessage.enqueue("outbox-1", buildEvent());
    expect(message.isDue(NOW)).toBe(true);
  });

  it("markPublished marca como publicada e não mais pendente/devida", () => {
    const message = OutboxMessage.enqueue("outbox-1", buildEvent());
    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(NOW);
    expect(message.isDue(NOW)).toBe(false);
  });

  it("scheduleRetry incrementa attempts e agenda nextAttemptAt com backoff exponencial", () => {
    const message = OutboxMessage.enqueue("outbox-1", buildEvent());

    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(1);
    const firstDelay = message.nextAttemptAt!.getTime() - NOW.getTime();
    expect(firstDelay).toBe(30_000);

    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(2);
    const secondDelay = message.nextAttemptAt!.getTime() - NOW.getTime();
    expect(secondDelay).toBe(60_000);
  });

  it("scheduleRetry respeita o teto de backoff", () => {
    const message = OutboxMessage.enqueue("outbox-1", buildEvent());
    for (let i = 0; i < 10; i += 1) {
      message.scheduleRetry(NOW);
    }
    const delay = message.nextAttemptAt!.getTime() - NOW.getTime();
    expect(delay).toBe(30 * 60_000);
  });

  it("isDue respeita nextAttemptAt", () => {
    const message = OutboxMessage.enqueue("outbox-1", buildEvent());
    message.scheduleRetry(NOW);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(message.nextAttemptAt!)).toBe(true);
  });

  it("rehydrate reconstrói o estado persistido", () => {
    const message = OutboxMessage.rehydrate({
      id: "outbox-1",
      aggregateId: "aggregate-1",
      eventType: "TestEvent",
      payload: { foo: "bar" },
      occurredAt: NOW,
      attempts: 3,
      nextAttemptAt: NOW,
      publishedAt: undefined,
    });
    expect(message.attempts).toBe(3);
    expect(message.isPending()).toBe(true);
  });
});
