export type LogFields = Record<string, unknown>;

/** Logs estruturados (JSON) — nunca payloads financeiros completos ou dados sensíveis. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
