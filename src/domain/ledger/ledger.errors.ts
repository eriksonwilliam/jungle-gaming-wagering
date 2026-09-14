import { DomainError } from "../shared/domain-error";

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";

  constructor(message: string) {
    super(message);
  }
}
