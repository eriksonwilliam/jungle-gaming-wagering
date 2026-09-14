import { MikroORM } from "@mikro-orm/postgresql";
import config from "../src/infrastructure/persistence/mikro-orm/mikro-orm.config";

/**
 * Roda migrations via API do MikroORM em vez do `@mikro-orm/cli` — o CLI
 * distribuído invoca um `.cmd` que sobe um processo Node separado no Windows,
 * e o carregamento ESM do Node quebra em caminho absoluto do Windows
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) mesmo quando invocado via `bunx`. Rodar
 * pela API, dentro do próprio processo Bun, evita o problema por completo.
 */
async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down") {
    console.error("uso: bun run scripts/migrate.ts <up|down>");
    process.exit(1);
  }

  const orm = await MikroORM.init(config);
  try {
    if (direction === "up") {
      await orm.migrator.up();
    } else {
      await orm.migrator.down();
    }
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
