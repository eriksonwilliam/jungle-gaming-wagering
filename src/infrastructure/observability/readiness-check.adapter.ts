import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { ReadinessCheck, ReadinessStatus } from "../../application/ports/readiness-check.port";

export class MikroOrmSqsReadinessCheck implements ReadinessCheck {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async check(): Promise<ReadinessStatus> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    return { postgres, sqs };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.em.getConnection().execute("select 1");
      return true;
    } catch {
      return false;
    }
  }

  private async checkSqs(): Promise<boolean> {
    try {
      await this.sqsClient.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ["QueueArn"] }));
      return true;
    } catch {
      return false;
    }
  }
}
