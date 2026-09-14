import { describe, expect, it } from "bun:test";
import { canonicalJsonHash } from "../../../../../src/application/use-cases/support/canonical-hash";

describe("canonicalJsonHash", () => {
  it("produz o mesmo hash independente da ordem das chaves", () => {
    const a = canonicalJsonHash({ providerId: "p", money: { amount: "10.00", currency: "BRL" } });
    const b = canonicalJsonHash({ money: { currency: "BRL", amount: "10.00" }, providerId: "p" });
    expect(a).toBe(b);
  });

  it("produz hashes diferentes para payloads diferentes", () => {
    const a = canonicalJsonHash({ amount: "10.00" });
    const b = canonicalJsonHash({ amount: "10.01" });
    expect(a).not.toBe(b);
  });

  it("trata null e undefined de forma estável", () => {
    expect(canonicalJsonHash(null)).toBe(canonicalJsonHash(undefined));
    expect(canonicalJsonHash({ a: null })).toBe(canonicalJsonHash({ a: undefined }));
  });

  it("serializa arrays preservando a ordem", () => {
    const a = canonicalJsonHash([1, 2, 3]);
    const b = canonicalJsonHash([3, 2, 1]);
    expect(a).not.toBe(b);
  });

  it("serializa valores primitivos", () => {
    expect(canonicalJsonHash("x")).toBe(canonicalJsonHash("x"));
    expect(canonicalJsonHash(1)).not.toBe(canonicalJsonHash("1"));
    expect(canonicalJsonHash(true)).not.toBe(canonicalJsonHash(false));
  });

  it("retorna um hex de 64 caracteres (sha256)", () => {
    expect(canonicalJsonHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
