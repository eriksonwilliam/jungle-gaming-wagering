import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import type { Logger } from "../../../application/ports/logger.port";
import { toHttpException } from "../errors/http-error-mapper";

@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const mapped = toHttpException(exception);
    if (mapped) {
      response.status(mapped.getStatus()).json(mapped.getResponse());
      return;
    }

    this.logger.error("unhandled_exception", {
      message: exception instanceof Error ? exception.message : String(exception),
      stack: exception instanceof Error ? exception.stack : undefined,
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "INTERNAL_ERROR", message: "erro interno inesperado" });
  }
}
