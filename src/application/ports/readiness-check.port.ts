export interface ReadinessStatus {
  postgres: boolean;
  sqs: boolean;
}

export interface ReadinessCheck {
  check(): Promise<ReadinessStatus>;
}
