import { MikroORM } from "@mikro-orm/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import mikroOrmConfig from "../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config";

export interface TestDatabase {
  orm: MikroORM;
  stop(): Promise<void>;
}

/**
 * Sobe um Postgres real em container (não mock) e aplica as migrations reais
 * do projeto — os testes de integração/concorrência rodam contra o mesmo
 * schema que produção usaria.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedTestContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "wagering", POSTGRES_PASSWORD: "wagering", POSTGRES_DB: "wagering" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const clientUrl = `postgresql://wagering:wagering@${host}:${port}/wagering`;

  const orm = await MikroORM.init({ ...mikroOrmConfig, clientUrl });
  await orm.migrator.up();

  return {
    orm,
    async stop() {
      await orm.close(true);
      await container.stop();
    },
  };
}
