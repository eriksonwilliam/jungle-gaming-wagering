import { createHash } from "node:crypto";

/**
 * SHA-256 de um JSON canônico (chaves ordenadas recursivamente). Usado como
 * `payloadHash` para idempotência — mesma entrada, mesmo hash, independente
 * da ordem em que o transporte serializou as chaves.
 */
export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
