/** Injetado em vez de chamar um gerador de UUID direto — testes precisam ser determinísticos. */
export interface IdGenerator {
  newId(): string;
}
