/**
 * Taxonomia estável e legível por máquina de motivos de rejeição/falha.
 * Documentada em ARCHITECTURE.md — o provedor usa este código para decidir
 * se reenvia, corrige o payload ou desiste.
 */
export const FAILURE_CODES = [
  "INSUFFICIENT_BALANCE",
  "REVERSAL_INSUFFICIENT_BALANCE",
  "CURRENCY_MISMATCH",
  "REFERENCE_MISMATCH",
  "REFERENCE_ALREADY_REVERSED",
  "REFERENCE_NOT_FOUND",
  "WALLET_NOT_FOUND",
  "INVALID_TRANSACTION_STATE",
  "PROCESSING_FAILED",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];
