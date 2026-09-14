import { HttpException, HttpStatus } from "@nestjs/common";
import { IdempotencyConflictError } from "../../../application/errors/idempotency-conflict.error";
import { ServiceUnavailableError } from "../../../application/errors/service-unavailable.error";
import { WalletAlreadyExistsError } from "../../../application/errors/wallet-already-exists.error";
import { WalletNotFoundError } from "../../../application/errors/wallet-not-found.error";
import { DomainError } from "../../../domain/shared/domain-error";

/**
 * Mapeamento único, centralizado, de erro de domínio/aplicação para status
 * HTTP — ver a tabela da seção 8 do ARCHITECTURE.md. Retorna `undefined`
 * para o que não reconhece, deixando o filtro global decidir o padrão (500).
 */
export function toHttpException(error: unknown): HttpException | undefined {
  if (error instanceof IdempotencyConflictError) {
    return new HttpException({ error: "IDEMPOTENCY_CONFLICT", message: error.message }, HttpStatus.CONFLICT);
  }
  if (error instanceof WalletAlreadyExistsError) {
    return new HttpException({ error: "WALLET_ALREADY_EXISTS", message: error.message }, HttpStatus.CONFLICT);
  }
  if (error instanceof WalletNotFoundError) {
    return new HttpException({ error: "WALLET_NOT_FOUND", message: error.message }, HttpStatus.NOT_FOUND);
  }
  if (error instanceof ServiceUnavailableError) {
    return new HttpException({ error: "SERVICE_UNAVAILABLE", message: error.message }, HttpStatus.SERVICE_UNAVAILABLE);
  }
  if (error instanceof DomainError) {
    return new HttpException({ error: error.code, message: error.message }, HttpStatus.BAD_REQUEST);
  }
  return undefined;
}
