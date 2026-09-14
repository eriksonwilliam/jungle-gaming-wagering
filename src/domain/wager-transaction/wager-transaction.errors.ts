import { DomainError } from "../shared/domain-error";

export class MissingReferenceError extends DomainError {
  readonly code = "MISSING_REFERENCE";

  constructor(kind: string) {
    super(`transação do tipo ${kind} exige referenceExternalTransactionId`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(currentStatus: string, attemptedTransition: string) {
    super(`transição "${attemptedTransition}" inválida a partir do estado terminal "${currentStatus}"`);
  }
}
