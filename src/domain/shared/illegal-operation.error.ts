import { DomainError } from "./domain-error";

/** Uso indevido de uma operação de domínio — indica erro de programação, não uma regra de negócio violada pelo usuário. */
export class IllegalOperationError extends DomainError {
  readonly code = "ILLEGAL_OPERATION";

  constructor(message: string) {
    super(message);
  }
}
