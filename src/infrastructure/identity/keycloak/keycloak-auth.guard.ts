import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC_KEY } from "../public.decorator";
import { KeycloakJwtVerifier } from "./keycloak-jwt-verifier";

@Injectable()
export class KeycloakAuthGuard implements CanActivate {
  constructor(
    private readonly verifier: KeycloakJwtVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { auth?: Record<string, unknown> }>();
    const header = request.headers["authorization"];
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException({ error: "MISSING_TOKEN", message: "cabeçalho Authorization: Bearer <token> ausente" });
    }

    const token = header.slice("Bearer ".length);
    try {
      request.auth = await this.verifier.verify(token);
      return true;
    } catch (error) {
      throw new UnauthorizedException({
        error: "INVALID_TOKEN",
        message: error instanceof Error ? error.message : "token inválido",
      });
    }
  }
}
