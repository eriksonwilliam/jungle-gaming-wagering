import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { ReadinessCheck, ReadinessStatus } from "../../../application/ports/readiness-check.port";
import { Public } from "../../identity/public.decorator";
import { READINESS_CHECK } from "../../tokens";

@ApiTags("health")
@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(READINESS_CHECK) private readonly readinessCheck: ReadinessCheck) {}

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: string; checks: ReadinessStatus }> {
    const checks = await this.readinessCheck.check();
    const ready = checks.postgres && checks.sqs;
    res.status(ready ? 200 : 503);
    return { status: ready ? "ok" : "not_ready", checks };
  }
}
