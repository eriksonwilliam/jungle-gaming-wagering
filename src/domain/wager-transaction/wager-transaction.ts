import type { Money } from "../money/money";
import { LedgerDirection } from "../ledger/ledger-direction";
import { IllegalOperationError } from "../shared/illegal-operation.error";
import type { FailureCode } from "./failure-code";
import { InvalidTransactionStateError, MissingReferenceError } from "./wager-transaction.errors";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const REFERENCE_REQUIRED_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Backoff do reprocessamento de PENDING_REFERENCE — ver ARCHITECTURE.md §7. */
const REFERENCE_RETRY_BASE_MS = 60_000;
const REFERENCE_RETRY_FACTOR = 4;
const REFERENCE_RETRY_MAX_MS = 4 * 60 * 60_000;
export const MAX_REFERENCE_ATTEMPTS = 8;

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface OpeningWagerTransactionProps {
  id: string;
  providerId: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  referenceAttempts?: number;
  referenceNextAttemptAt?: Date;
}

/**
 * PROCESSED, REJECTED e FAILED são terminais: uma vez alcançados, nenhuma
 * outra transição é permitida — tentar fazê-lo é erro de programação
 * (InvalidTransactionStateError), não um caminho de negócio esperado.
 *
 * Transições válidas: PENDING → {PROCESSED, PENDING_REFERENCE, REJECTED, FAILED}
 * e PENDING_REFERENCE → {PROCESSED, REJECTED, FAILED}.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceAttempts: number = 0,
    private _referenceNextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. OPENING não pode ser criado aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (REFERENCE_REQUIRED_KINDS.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new MissingReferenceError(props.kind);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Transação interna de abertura de wallet — nasce diretamente PROCESSED,
   * pois é aplicada de forma síncrona e atômica na criação da wallet. Não
   * pode ser produzida pela API nem pela fila (ver `create`).
   */
  static openingFor(props: OpeningWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.id,
      props.id,
      "opening",
      props.walletId,
      props.playerId,
      "opening",
      "opening",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.referenceAttempts ?? 0,
      state.referenceNextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get referenceNextAttemptAt(): Date | undefined {
    return this._referenceNextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** Está PENDING_REFERENCE e a próxima tentativa de reprocessamento já é devida. */
  isReferenceRetryDue(now: Date): boolean {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      return false;
    }
    return this._referenceNextAttemptAt === undefined || this._referenceNextAttemptAt.getTime() <= now.getTime();
  }

  hasExhaustedReferenceRetries(): boolean {
    return this._referenceAttempts >= MAX_REFERENCE_ATTEMPTS;
  }

  /** Incrementa referenceAttempts e agenda a próxima tentativa (backoff exponencial, teto 4h). */
  scheduleReferenceRetry(at: Date): void {
    this.assertNotTerminal("scheduleReferenceRetry");
    this._referenceAttempts += 1;
    const delayMs = Math.min(
      REFERENCE_RETRY_BASE_MS * REFERENCE_RETRY_FACTOR ** (this._referenceAttempts - 1),
      REFERENCE_RETRY_MAX_MS,
    );
    this._referenceNextAttemptAt = new Date(at.getTime() + delayMs);
  }

  /** false apenas para LOSS — a única kind que não move saldo nem gera ledger. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REFERENCE_REQUIRED_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger. ROLLBACK inverte a direção da
   * transação referenciada (reverte um débito com crédito e vice-versa);
   * por isso exige `reference` explicitamente.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new IllegalOperationError(
            "ROLLBACK exige a transação de referência para determinar a direção do lançamento",
          );
        }
        const referenceDirection = reference.ledgerDirectionFor();
        return referenceDirection === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new IllegalOperationError("LOSS não afeta o saldo e não tem direção de lançamento");
    }
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, attemptedTransition);
    }
  }
}
