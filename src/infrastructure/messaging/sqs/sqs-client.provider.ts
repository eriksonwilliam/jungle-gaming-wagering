import { SQSClient } from "@aws-sdk/client-sqs";

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}
