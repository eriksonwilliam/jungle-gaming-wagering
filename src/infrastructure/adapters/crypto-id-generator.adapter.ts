import type { IdGenerator } from "../../application/ports/id-generator.port";

export class CryptoIdGenerator implements IdGenerator {
  newId(): string {
    return crypto.randomUUID();
  }
}
