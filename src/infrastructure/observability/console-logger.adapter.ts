import type { Logger, LogFields } from "../../application/ports/logger.port";

const SENSITIVE_KEYS = new Set(["password", "token", "authorization"]);

/**
 * Logs estruturados em JSON no stdout. Redige credenciais explicitamente;
 * a disciplina de não logar payload financeiro completo é do call site (loga
 * campos específicos — ex.: `walletId`, `difference` — não o objeto inteiro
 * do request), não um filtro genérico aqui, que quebraria logs legítimos
 * como a divergência de reconciliação. Ver ARCHITECTURE.md §12.
 */
export class ConsoleLogger implements Logger {
  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: string, message: string, fields?: LogFields): void {
    const line = { level, message, timestamp: new Date().toISOString(), ...sanitize(fields) };
    console.log(JSON.stringify(line));
  }
}

function sanitize(fields?: LogFields): LogFields {
  if (!fields) {
    return {};
  }
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return result;
}
