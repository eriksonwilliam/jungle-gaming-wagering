import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Marca um handler/controller como isento do AuthGuard global — health checks (seção 2 do desafio). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
