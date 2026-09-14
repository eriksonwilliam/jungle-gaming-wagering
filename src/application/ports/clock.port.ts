/** Injetado em vez de chamar `new Date()` direto — testes precisam ser determinísticos. */
export interface Clock {
  now(): Date;
}
