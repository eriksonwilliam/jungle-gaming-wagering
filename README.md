# Wagering Processor

Serviço financeiro distribuído que processa operações de aposta (`BET`, `WIN`,
`LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores, com garantia de
correção sob entrega duplicada, fora de ordem e múltiplas instâncias rodando em
paralelo. Decisões técnicas e trade-offs estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

- Runtime / test runner: Bun 1.x
- Linguagem: TypeScript (modo estrito)
- Framework: NestJS 12
- Banco: PostgreSQL
- ORM: MikroORM 7
- Mensageria: AWS SQS via LocalStack
- Identidade: Keycloak (OIDC)
- Orquestração local: Docker Compose

`bun audit`: **0 vulnerabilidades conhecidas** (ver [ARCHITECTURE.md §2.1](ARCHITECTURE.md#21-versões--nestjs-12--mikroorm-7-zero-vulnerabilidades-conhecidas)).

## Setup

Pré-requisitos: [Bun 1.x](https://bun.sh), Docker e Docker Compose.

```bash
bun install
docker compose up -d --build
bun run migration:up
```

`docker compose up` já sobe três instâncias da aplicação (`app1`, `app2`,
`app3`) atrás de um reverse proxy `nginx` que distribui as requisições REST
entre elas por round-robin — o cliente HTTP bate sempre em
`http://localhost:3000`, sem escolher instância manualmente. As portas
`3001`/`3002`/`3003` continuam expostas diretamente para inspeção pontual de
uma instância específica em debug. `migrate` roda as migrations uma vez antes
das instâncias subirem. Para rodar só a aplicação localmente contra a infra
do compose:

```bash
docker compose up -d postgres localstack keycloak
cp .env.example .env   # ajuste se necessário
bun run migration:up
bun run start:dev
```

A API sobe em `http://localhost:3000` — via compose, esse endereço é o
`nginx`; localmente, é a própria aplicação — com Swagger/OpenAPI em `/docs`.
`/health/live` e `/health/ready` não exigem autenticação; os demais endpoints
exigem `Authorization: Bearer <token>`.

### Obtendo um token do Keycloak

O realm `wagering` é importado automaticamente (`deploy/keycloak/realm-export.json`),
com o client público `wagering-api` e o usuário `provider-a` / `provider-a`:

```bash
curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d 'client_id=wagering-api' \
  -d 'grant_type=password' \
  -d 'username=provider-a' \
  -d 'password=provider-a' | jq -r .access_token
```

Use o `access_token` retornado no header `Authorization: Bearer`.

## Comandos

```bash
bun test                 # testes unitários (domain + application), com gate de cobertura 100%
bun test:coverage        # idem, com relatório de cobertura
bun test:integration     # Postgres + LocalStack reais via testcontainers
bun test:concurrency     # cenários de concorrência com paralelismo real
bun run test:load        # teste de carga contra a stack já rodando (docker compose up), via nginx
bun run typecheck        # tsc --noEmit
bun run lint             # eslint
bun run build            # bundle de produção (é o que a imagem Docker roda)
bun audit                # vulnerabilidades conhecidas nas dependências
```

## Estrutura

```
src/
  domain/          regras de negócio puras (Money, Wallet, WagerTransaction, Ledger, Inbox, Outbox)
  application/     casos de uso + portas
  infrastructure/  HTTP, persistência (MikroORM), mensageria (SQS), identidade (Keycloak), observabilidade
migrations/        migrations MikroORM, versionadas e reversíveis
scripts/           scripts operacionais (migração via API do MikroORM — ver ARCHITECTURE.md §12.2)
deploy/
  keycloak/        realm importado automaticamente pelo docker-compose
  localstack/      script que provisiona as filas SQS na subida do LocalStack
test/
  unit/            domain + application, mocks de portas — 100% de cobertura
  integration/     Postgres + LocalStack reais via testcontainers
  concurrency/     paralelismo real, múltiplas instâncias
  load/            teste de carga manual (diferencial opcional)
```

## Status de verificação

`bun test` (150 testes, 100% de cobertura em `domain/`+`application/`),
`bun test:integration` (13 testes) e `bun test:concurrency` (6 testes) rodam
verdes contra Postgres e LocalStack reais em container — cenário obrigatório
da seção 8, 50 requisições duplicadas em paralelo, 3 instâncias reais,
referência entregue fora de ordem, dois publishers na mesma outbox, publish
real no SQS, as 4 constraints de schema, e o `WagerTransactionConsumer` real
consumindo a fila (inbox/redelivery, retry transitório com recuperação por
outra instância, DLQ e `SIGTERM` — ver ARCHITECTURE.md §12.5). Os três
scripts (`test`, `test:integration`, `test:concurrency`) terminam com exit
code 0 quando passam — `test:integration`/`test:concurrency` sozinhos não
aplicam o gate de cobertura de 100% (isso é papel do `test:coverage`, que
passa `--coverage` explicitamente).

`docker compose up -d --build` sobe a stack completa (Postgres, LocalStack,
Keycloak, `migrate`, `nginx`, `app1`/`app2`/`app3` já rodando o **bundle de
produção**, não o código-fonte) e o fluxo de ponta a ponta foi exercitado
manualmente: token real do Keycloak → criar wallet na instância 1 → BET na
instância 2 → replay idempotente na instância 2 → ler o saldo atualizado na
instância 3 — confirmando que as três instâncias compartilham o mesmo estado
via Postgres de verdade. `/health/ready` e `/docs` também verificados nas três
instâncias. O round-robin do `nginx` foi verificado à parte: 69 requisições
para `http://localhost:3000/health/live` renderam 20/26/23 entre `app1`,
`app2` e `app3` — cada instância healthy antes do `nginx` roteá-la (depende de
`condition: service_healthy` nas três).

`bun run test:load` rodou contra o `nginx` (as 3 instâncias reais por trás,
não uma isolada): 255.9 req/s com 20 wallets, caindo para 194.7 req/s com 2
wallets sob a mesma concorrência (p95 mais que dobra — efeito visível do lock
pessimista de linha sob contenção, agora com o tráfego de fato distribuído
entre as três) — metodologia e números completos em
[ARCHITECTURE.md §13](ARCHITECTURE.md#13-teste-de-carga-diferencial-opcional).

Vários bugs reais só apareceram rodando contra infraestrutura de verdade
(nenhum mock os pegava) e foram corrigidos durante essa validação — detalhes
em [ARCHITECTURE.md §12.1](ARCHITECTURE.md#121-validado-contra-infraestrutura-real).
