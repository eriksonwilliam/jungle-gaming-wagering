import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { IntegrationEvent, type IntegrationEventProps } from "../../src/domain/messaging/integration-event";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs/sqs-event-publisher.adapter";
import { startTestLocalstack, type TestLocalstack } from "./support/test-localstack";

interface TestData {
  foo: string;
}

class TestEvent extends IntegrationEvent<TestData> {
  readonly eventType = "TestEvent";
  readonly version = 1;

  constructor(props: IntegrationEventProps<TestData>) {
    super(props);
  }
}

let localstack: TestLocalstack;

beforeAll(async () => {
  localstack = await startTestLocalstack();
}, 60_000);

afterAll(async () => {
  await localstack.stop();
});

describe("SqsEventPublisher — LocalStack real", () => {
  it("publica e a mensagem pode ser recebida de volta da fila FIFO", async () => {
    const publisher = new SqsEventPublisher(localstack.client, localstack.queueUrl);
    const event = new TestEvent({
      eventId: "event-1",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      occurredAt: new Date(),
      data: { foo: "bar" },
    });
    const message = OutboxMessage.enqueue("outbox-1", event);

    await publisher.publish(message);

    const response = await localstack.client.send(
      new ReceiveMessageCommand({ QueueUrl: localstack.queueUrl, WaitTimeSeconds: 5, MaxNumberOfMessages: 1 }),
    );

    expect(response.Messages).toHaveLength(1);
    const body = JSON.parse(response.Messages![0]!.Body as string);
    expect(body.eventType).toBe("TestEvent");
    expect(body.data).toEqual({ foo: "bar" });
  });
});
