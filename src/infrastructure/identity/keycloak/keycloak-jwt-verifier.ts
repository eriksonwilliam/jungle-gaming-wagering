import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

export class JwtVerificationError extends Error {}

/**
 * Verificação de JWT RS256 contra a JWKS do Keycloak, sem biblioteca de JWT —
 * mesmo padrão já usado para HS256 com `node:crypto` em outros projetos,
 * adaptado para verificação de assinatura RSA nativa. Ver ARCHITECTURE.md §10.
 */
export class KeycloakJwtVerifier {
  private readonly jwksCache = new Map<string, KeyObject>();
  private jwksFetchedAt = 0;
  private readonly jwksTtlMs = 5 * 60_000;

  constructor(
    private readonly jwksUrl: string,
    private readonly issuer: string,
    private readonly audience?: string,
  ) {}

  async verify(token: string): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new JwtVerificationError("token malformado");
    }
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = this.decodeJson(headerB64);
    if (header["alg"] !== "RS256") {
      throw new JwtVerificationError(`algoritmo não suportado: ${String(header["alg"])}`);
    }
    const kid = header["kid"];
    if (typeof kid !== "string") {
      throw new JwtVerificationError("token sem kid");
    }

    const key = await this.getKey(kid);
    const signature = Buffer.from(signatureB64, "base64url");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    if (!verifier.verify(key, signature)) {
      throw new JwtVerificationError("assinatura inválida");
    }

    const payload = this.decodeJson(payloadB64);
    this.assertClaims(payload);
    return payload;
  }

  private assertClaims(payload: Record<string, unknown>): void {
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload["exp"] === "number" && payload["exp"] < now) {
      throw new JwtVerificationError("token expirado");
    }
    if (payload["iss"] !== this.issuer) {
      throw new JwtVerificationError("issuer inválido");
    }
    if (this.audience) {
      const aud = payload["aud"];
      const audiences = Array.isArray(aud) ? aud : [aud];
      if (!audiences.includes(this.audience)) {
        throw new JwtVerificationError("audience inválida");
      }
    }
  }

  private decodeJson(base64url: string): Record<string, unknown> {
    try {
      return JSON.parse(Buffer.from(base64url, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new JwtVerificationError("segmento do token não é JSON válido");
    }
  }

  private async getKey(kid: string): Promise<KeyObject> {
    if (Date.now() - this.jwksFetchedAt > this.jwksTtlMs || !this.jwksCache.has(kid)) {
      await this.refreshJwks();
    }
    const key = this.jwksCache.get(kid);
    if (!key) {
      throw new JwtVerificationError(`kid desconhecido: ${kid}`);
    }
    return key;
  }

  private async refreshJwks(): Promise<void> {
    const response = await fetch(this.jwksUrl);
    if (!response.ok) {
      throw new JwtVerificationError(`falha ao buscar JWKS: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { keys: Jwk[] };
    this.jwksCache.clear();
    for (const jwk of body.keys) {
      if (jwk.kty !== "RSA") {
        continue;
      }
      const keyObject = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
      this.jwksCache.set(jwk.kid, keyObject);
    }
    this.jwksFetchedAt = Date.now();
  }
}
