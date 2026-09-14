import { describe, expect, it } from "bun:test";
import { IntegrationEvent, type IntegrationEventProps } from "../../../../src/domain/messaging/integration-event";
import { OutboxMessage } from "../../../../src/domain/messaging/outbox-message";
import { PublishOutboxBatch } from "../../../../src/application/use-cases/publish-outbox-batch.use-case";
import { FakeClock, FakeEventPublisher, FakeLogger, FakeMetrics, InMemoryOutboxRepository } from "../support/fakes";

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

function buildMessage(id: string): OutboxMessage {
  return OutboxMessage.enqueue(
    id,
    new TestEvent({ eventId: id, aggregateId: "agg-1", correlationId: "corr-1", occurredAt: NOW, data: { foo: "bar" } }),
  );
}

function buildSut() {
  const outboxRepository = new InMemoryOutboxRepository();
  const eventPublisher = new FakeEventPublisher();
  const clock = new FakeClock(NOW);
  const logger = new FakeLogger();
  const metrics = new FakeMetrics();
  const useCase = new PublishOutboxBatch(outboxRepository, eventPublisher, clock, logger, metrics);
  return { outboxRepository, eventPublisher, clock, logger, metrics, useCase };
}

describe("PublishOutboxBatch", () => {
  it("publica mensagens devidas e marca como publicadas", async () => {
    const { outboxRepository, eventPublisher, metrics, useCase } = buildSut();
    const message = buildMessage("outbox-1");
    outboxRepository.messages.push(message);

    const result = await useCase.execute();

    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(eventPublisher.published).toHaveLength(1);
    expect(message.isPending()).toBe(false);
    expect(metrics.histogramObservations["outbox_publish_lag_ms"]).toEqual([0]); // FakeClock parado: publishedAt === occurredAt
  });

  it("reagenda com backoff quando a publicação falha, sem derrubar o lote", async () => {
    const { outboxRepository, eventPublisher, logger, metrics, useCase } = buildSut();
    const failing = buildMessage("outbox-1");
    const succeeding = buildMessage("outbox-2");
    outboxRepository.messages.push(failing, succeeding);
    eventPublisher.failNext = true;

    const result = await useCase.execute();

    expect(result.published).toBe(1);
    expect(result.failed).toBe(1);
    expect(failing.attempts).toBe(1);
    expect(failing.nextAttemptAt).toBeDefined();
    expect(succeeding.isPending()).toBe(false);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.level).toBe("warn");
    expect(metrics.counters["wager_transactions_retries_total"]).toBe(1);
  });

  it("respeita o batchSize informado", async () => {
    const { outboxRepository, useCase } = buildSut();
    outboxRepository.messages.push(buildMessage("outbox-1"), buildMessage("outbox-2"));

    const result = await useCase.execute(1);

    expect(result.published).toBe(1);
  });

  it("não publica mensagens ainda não devidas", async () => {
    const { outboxRepository, useCase, clock } = buildSut();
    const message = buildMessage("outbox-1");
    message.scheduleRetry(clock.now());
    outboxRepository.messages.push(message);

    const result = await useCase.execute();

    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
  });
});
