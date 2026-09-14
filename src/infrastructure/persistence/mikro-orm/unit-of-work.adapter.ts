import { RequestContext } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork } from "../../../application/ports/unit-of-work.port";

/**
 * `RequestContext.create(orm.em, ...)` estabelece um EntityManager forkado
 * ligado ao contexto assíncrono da chamada — necessário porque nem todo
 * `run()` acontece dentro de uma requisição HTTP (o middleware do MikroORM só
 * cobre isso); workers e o consumidor SQS também chamam `UnitOfWork.run`.
 * Criar o contexto aqui funciona nos dois casos: se já existir um contexto
 * HTTP ambiente, este apenas aninha um fork adicional (suportado pelo
 * MikroORM); se não existir (job em background), cria o primeiro. Dentro
 * dele, `em.transactional()` propaga a transação para qualquer repositório
 * injetado com o mesmo `orm.em` — ver ARCHITECTURE.md §4.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return RequestContext.create(this.orm.em, () => this.orm.em.transactional(() => fn()));
  }
}
