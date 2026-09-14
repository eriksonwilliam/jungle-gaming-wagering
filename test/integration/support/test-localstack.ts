import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

export interface TestLocalstack {
  client: SQSClient;
  queueUrl: string;
  stop(): Promise<void>;
}

/** Sobe LocalStack real (não mock) com uma fila FIFO de teste provisionada via SDK. */
export async function startTestLocalstack(queueName = "test-events.fifo"): Promise<TestLocalstack> {
  const container: StartedTestContainer = await new GenericContainer("localstack/localstack:3")
    .withEnvironment({ SERVICES: "sqs" })
    .withExposedPorts(4566)
    .withWaitStrategy(Wait.forLogMessage(/Ready\./, 1))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;
  const client = new SQSClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: "true" } }),
  );

  return {
    client,
    queueUrl: QueueUrl as string,
    async stop() {
      client.destroy();
      await container.stop();
    },
  };
}
