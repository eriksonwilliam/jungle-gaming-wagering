/**
 * Executa `fn` dentro de uma única transação SQL. Toda porta de repositório
 * usada dentro de `fn` deve enxergar o mesmo contexto transacional — no
 * adapter MikroORM isso é garantido pelo `EntityManager` forkado que
 * `em.transactional()` propaga via contexto assíncrono, sem precisar passá-lo
 * explicitamente por parâmetro.
 */
export interface UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
