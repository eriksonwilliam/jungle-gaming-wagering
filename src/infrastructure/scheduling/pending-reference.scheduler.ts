import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { ProcessPendingReferences } from "../../application/use-cases/process-pending-references.use-case";
import { runInDbContext } from "../persistence/mikro-orm/run-in-context";

const DEFAULT_INTERVAL_MS = 30_000;

export class PendingReferenceScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly processPendingReferences: ProcessPendingReferences,
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
      await runInDbContext(this.orm, () => this.processPendingReferences.execute());
    } finally {
      this.running = false;
    }
  }
}
