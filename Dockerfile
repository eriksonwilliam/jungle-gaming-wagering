# ---- deps: instala apenas dependências de produção ----
FROM oven/bun:1 AS deps
WORKDIR /app
# bunfig.toml precisa vir junto do install: define linker = "isolated",
# sem o qual um conflito real de versão do ajv (eslint quer v6, uma
# dependência transitiva de migrations quer v8) quebra o MikroORM em runtime
# — ver ARCHITECTURE.md §12.2.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# ---- build: gera o bundle de produção ----
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
# @nestjs/microservices e @nestjs/websockets são opcionais (o Nest só os
# carrega via import() dinâmico se o app realmente os usar) — não estão
# instalados aqui, então precisam ficar de fora do bundle (--external) ou o
# bundler tenta resolvê-los estaticamente e quebra o build. swagger-ui-dist
# também fica external porque @nestjs/swagger resolve o caminho dos seus
# assets estáticos (HTML/CSS/fonts) em runtime via require.resolve — um
# bundle não carrega esses arquivos, só a lógica JS. Ver ARCHITECTURE.md §10.2.
RUN bun run build

# ---- runtime: imagem slim, roda o bundle de produção ----
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json bunfig.toml tsconfig.json ./
COPY migrations ./migrations
COPY scripts ./scripts
# src/ continua presente porque o serviço `migrate` do docker-compose sobe
# esta mesma imagem com o comando `bun run scripts/migrate.ts`, que importa
# a config do MikroORM direto do código-fonte, não do bundle.
COPY src ./src

EXPOSE 3000
CMD ["bun", "run", "dist/main.js"]
