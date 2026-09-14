import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { IntegrationEvent, type IntegrationEventProps } from "../../src/domain/messaging/integration-event";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import mikroOrmConfig from "../../src/infrastructure/persistence/mikro-orm/mikro-orm.config";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/outbox.repository";
import { runInDbContext } from "../../src/infrastructure/persistence/mikro-orm/run-in-context";
import type { EventPublisher } from "../../src/application/ports/event-publisher.port";
import { PublishOutboxBatch } from "../../src/application/use-cases/publish-outbox-batch.use-case";
import { FakeClock, FakeLogger, FakeMetrics } from "../unit/application/support/fakes";
import { startTestDatabase, type TestDatabase } from "../integration/support/test-database";

interface TestData {
  index: number;
}

class TestEvent extends IntegrationEvent<TestData> {
  readonly eventType = "TestEvent";
  readonly version = 1;

  constructor(props: IntegrationEventProps<TestData>) {
    super(props);
  }
}

class RecordingPublisher implements EventPublisher {
  readonly publishedIds: string[] = [];

  async publish(message: OutboxMessage): Promise<void> {
    this.publishedIds.push(message.id);
  }
}

let db: TestDatabase;
let ormB: MikroORM;

const MESSAGE_COUNT = 20;

beforeAll(async () => {
  db = await startTestDatabase();
  const clientUrl = db.orm.config.get("clientUrl") as string;
  ormB = await MikroORM.init({ ...mikroOrmConfig, clientUrl });
}, 60_000);

afterAll(async () => {
  await ormB.close();
  await db.stop();
});

describe("Concorrência — dois publishers sobre a mesma outbox (Postgres real)", () => {
  it("publishers concorrentes reivindicam lotes disjuntos e nenhuma mensagem é perdida ou processada duas vezes", async () => {
    const now = new Date();
    await runInDbContext(db.orm, async () => {
      const outboxRepository = new MikroOrmOutboxRepository(db.orm.em);
      for (let i = 0; i < MESSAGE_COUNT; i += 1) {
        const event = new TestEvent({
          eventId: randomUUID(),
          aggregateId: `wallet-${i}`,
          correlationId: "corr",
          occurredAt: now,
          data: { index: i },
        });
        await outboxRepository.save(OutboxMessage.enqueue(randomUUID(), event));
      }
    });

    const publisherA = new RecordingPublisher();
    const publisherB = new RecordingPublisher();
    const clock = new FakeClock(now);

    const batchA = new PublishOutboxBatch(new MikroOrmOutboxRepository(db.orm.em), publisherA, clock, new FakeLogger(), new FakeMetrics());
    const batchB = new PublishOutboxBatch(new MikroOrmOutboxRepository(ormB.em), publisherB, clock, new FakeLogger(), new FakeMetrics());

    await Promise.all([
      runInDbContext(db.orm, () => batchA.execute(MESSAGE_COUNT)),
      runInDbContext(ormB, () => batchB.execute(MESSAGE_COUNT)),
    ]);

    const allPublished = [...publisherA.publishedIds, ...publisherB.publishedIds];
    expect(new Set(allPublished).size).toBe(allPublished.length); // nenhuma reivindicada duas vezes
    expect(allPublished).toHaveLength(MESSAGE_COUNT); // nenhuma perdida
  });
});
