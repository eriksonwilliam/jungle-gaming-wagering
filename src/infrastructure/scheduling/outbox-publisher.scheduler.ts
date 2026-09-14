import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { PublishOutboxBatch } from "../../application/use-cases/publish-outbox-batch.use-case";
import { runInDbContext } from "../persistence/mikro-orm/run-in-context";

const DEFAULT_INTERVAL_MS = 2_000;

/** Poll simples via setInterval — evita depender de @nestjs/schedule para um agendamento trivial. */
export class OutboxPublisherScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly publishOutboxBatch: PublishOutboxBatch,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await runInDbContext(this.orm, () => this.publishOutboxBatch.execute());
    } finally {
      this.running = false;
    }
  }
}
