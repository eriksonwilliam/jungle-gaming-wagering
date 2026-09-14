import { RequestContext } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";

/**
 * Estabelece um EntityManager forkado ligado ao contexto assíncrono da
 * chamada. Necessário para todo trabalho que roda fora do middleware HTTP do
 * MikroORM — schedulers e o consumidor SQS — antes de tocar qualquer
 * repositório ou `UnitOfWork.run`.
 */
export function runInDbContext<T>(orm: MikroORM, fn: () => Promise<T>): Promise<T> {
  return RequestContext.create(orm.em, fn);
}
