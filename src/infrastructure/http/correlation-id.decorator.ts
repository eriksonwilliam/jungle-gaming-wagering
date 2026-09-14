import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** Usa `x-correlation-id` do request quando presente; gera um novo id caso contrário. */
export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const header = request.headers["x-correlation-id"];
  if (typeof header === "string" && header.length > 0) {
    return header;
  }
  return crypto.randomUUID();
});
