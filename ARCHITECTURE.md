# Arquitetura

Este documento registra as decisões técnicas do Wagering Processor, os trade-offs
considerados e as limitações conhecidas. É atualizado à medida que cada camada é
implementada — a versão nesta seção reflete o estado atual do projeto.

## 1. Visão geral

Serviço financeiro distribuído (NestJS + Bun + PostgreSQL + SQS) que processa
operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos
provedores, com garantia de correção sob duplicação, reordenação, concorrência
entre instâncias e falhas de processo.

Arquitetura hexagonal em três camadas:

- `src/domain`: regras de negócio puras (Money, Wallet, WagerTransaction,
  WalletLedgerEntry, InboxMessage, OutboxMessage). Sem framework, sem I/O.
- `src/application`: casos de uso + portas (interfaces) que o domínio precisa do
  mundo externo (repositórios, relógio, gerador de id, publicador de eventos).
- `src/infrastructure`: adapters que implementam as portas — HTTP (NestJS),
  persistência (MikroORM/PostgreSQL), mensageria (SQS), identidade (Keycloak),
  observabilidade e scheduling.

## 2. ORM — MikroORM

Escolhido em vez de TypeORM porque `EntityManager.transactional()` e `LockMode`
tornam explícito, no código de aplicação, o limite da transação e o tipo de lock
usado — não há transação implícita escondida em um decorator. Isso é relevante
porque a unidade de transação deste sistema (wallet + ledger + inbox + outbox no
mesmo commit) é a garantia mais importante do desafio.

`Money` é persistido como duas colunas simples por entidade
(`*_minor_units bigint`, `currency char(3)`); a conversão bigint↔string↔`Money`
acontece explicitamente nas funções `toDomain`/mapeamento de cada repositório
(`src/infrastructure/persistence/mikro-orm/repositories/*.ts`), não num `Type`
customizado do MikroORM — mais simples e igualmente suficiente, já que o
domínio nunca importa nada de `@mikro-orm/core` de qualquer forma (as entidades
MikroORM são classes à parte, mapeadas na borda do repositório, nunca o
próprio agregado de domínio).

## 2.1 Versões — NestJS 12 + MikroORM 7, zero vulnerabilidades conhecidas

O projeto rodou boa parte do desenvolvimento em NestJS 10.x + MikroORM 6.x
(escolha inicial, mais conservadora). Ao rodar `bun audit` (nativo do Bun,
usa o banco de advisories do GitHub), apareceram 37 vulnerabilidades — todas
transitivas, herdadas das dependências do próprio NestJS 10.x (`multer`,
`body-parser`, `qs`, `js-yaml`, `lodash`, um `ajv` desatualizado, e uma
injeção em `SseStream` do `@nestjs/core` — [CVE-2026-35515](https://github.com/advisories/GHSA-36xv-jgw5-4q75),
não exercitada aqui porque este serviço não usa Server-Sent Events).

Decisão: migrar para **NestJS 12** + **MikroORM 7** (últimas majors estáveis),
já que era só questão de tempo antes de precisar de qualquer jeito, e o
desafio não impõe uma versão específica de nenhum dos dois. Resultado depois
da migração e de um `overrides.multer` no `package.json` (a única vulnerável
que sobrou depois do Nest 12 e que o Nest 12 ainda pinava numa versão
vulnerável) mais um `bun add -d testcontainers@latest` (resolve `undici`/
`uuid`, só usados em teste): **`bun audit` → 0 vulnerabilidades**.

## 3. Money — BigInt de centavos, não uma lib de decimal

O enunciado modela `Money` sobre um campo `Decimal` interno. Em vez de trazer
`decimal.js` (ou similar), essa classe é implementada como um wrapper próprio
sobre `bigint`, guardando o valor em centavos:

- Toda moeda usada aqui (BRL, e o contrato multi-moeda em geral) tem escala fixa
  de 2 casas — é exatamente representável como inteiro, sem qualquer perda.
- `bigint` nativo do JS tem aritmética exata (sem arredondamento de ponto
  flutuante) e não custa dependência.
- Segue o padrão já adotado em outros projetos: dinheiro em centavos, inteiro.

Validação de entrada (`Money.from`): rejeita `NaN`, `Infinity`, notação
científica, string vazia, mais de 2 casas decimais e valores negativos, via
regex estrita (`/^\d+\.\d{2}$/` para entrada, com variante que aceita sinal
apenas internamente para representar débito no ledger) antes de converter para
`bigint`. Nunca há um `number` na cadeia entre a string de entrada e o `bigint`.

## 4. Concorrência — lock pessimista por linha da wallet

A unidade de concorrência é `walletId`. Dentro da mesma transação SQL que aplica
uma operação, a wallet é lida com `LockMode.PESSIMISTIC_WRITE`
(`SELECT ... FOR UPDATE`), o que serializa apenas as transações que disputam
aquela linha — outras wallets continuam em paralelo, sem lock global.

Alternativa considerada: optimistic locking via coluna `version` com retry.
Descartada como estratégia principal porque, sob "hot wallet" (muitas apostas
simultâneas na mesma carteira — o cenário obrigatório da seção 8 do desafio),
geraria uma cascata de conflitos e retries desnecessária; o lock de linha resolve
o mesmo problema com uma única espera na fila do Postgres. A coluna `version`
continua existindo na tabela — incrementada a cada mudança de saldo — para
leitura otimista fora de transação e para auditoria/reconciliação.

## 5. Idempotência e unicidade — no schema, não só em código

- `wager_transactions.idempotency_key` é `UNIQUE`. É a fonte da verdade da
  idempotência HTTP (header `Idempotency-Key`).
- `wager_transactions (provider_id, external_transaction_id)` é `UNIQUE` —
  a chave de negócio do provedor, independente do header.
- `payload_hash` (hash SHA-256 de um JSON canônico — chaves ordenadas
  recursivamente — do subconjunto de campos de negócio do payload, sem o header
  nem metadados de transporte) é comparado em toda repetição de
  `idempotency_key`: mesmo hash → replay (retorna o resultado original); hash
  diferente → conflito (409), nunca um replay silencioso.
- `inbox_messages` tem chave primária composta `(consumer_name, message_id)` —
  dedup do consumidor SQS no nível do banco, não em memória.
- Reversão única por tipo: índice único parcial
  `UNIQUE (reference_transaction_id, kind) WHERE status = 'PROCESSED'` impede
  duas `REFUND` ou dois `ROLLBACK` processados para a mesma referência.
- `wallets.balance_minor` tem `CHECK (balance_minor >= 0)` — saldo negativo é
  impossível mesmo se a camada de aplicação tiver um bug.
- Ledger imutável: a aplicação nunca executa `UPDATE`/`DELETE` em
  `wallet_ledger_entries`; um trigger de banco rejeita essas operações mesmo que
  alguém tente pela aplicação ou por acesso direto.

## 5.1 Filas SQS

O desafio nomeia `wager-transactions.fifo` / `wager-transactions-dlq.fifo` para
a entrada (provedor → sistema). Para a saída (os 4 eventos de integração da
seção 11), o enunciado não nomeia uma fila — escolhi `wagering-events.fifo`,
sem DLQ própria: quem consome esses eventos é um sistema externo, e a
responsabilidade por retry/DLQ da própria leitura é dele, não deste serviço
(nosso lado da responsabilidade termina em publicar com sucesso).

## 6. Outbox — relay com `SELECT ... FOR UPDATE SKIP LOCKED`

A escrita do evento de integração acontece na mesma transação SQL que persiste a
mudança de saldo (nunca antes do commit). Um worker de publicação — que pode
rodar em múltiplas instâncias simultaneamente — reivindica um lote de mensagens
pendentes com `FOR UPDATE SKIP LOCKED`, publica no SQS e marca como publicadas.
`SKIP LOCKED` garante que dois publishers concorrentes peguem lotes disjuntos,
sem se bloquear e sem publicar a mesma linha em paralelo. Uma falha entre
publicar e marcar como publicada é aceitável: o evento é publicado de novo (o
SQS já é at-least-once) e o consumidor final deduplica pela própria mensagem.
As linhas reivindicadas ganham uma janela de reserva de 60s (`nextAttemptAt`
temporário, fora da transação de claim) para que um publisher morto entre o
claim e a publicação não segure a mensagem indefinidamente — outro publisher
reivindica de novo passada a janela.

## 7. Referências fora de ordem

`REFUND`/`ROLLBACK` que chegam antes da transação referenciada persistem como
`PENDING_REFERENCE`. O próprio agregado `WagerTransaction` guarda
`referenceAttempts`/`referenceNextAttemptAt` e calcula o backoff
(`scheduleReferenceRetry`): base de 1 minuto, fator 4, teto de 4h por tentativa,
até 8 tentativas — soma pouco mais de 17h de espera acumulada antes de desistir,
suficiente para cobrir atrasos razoáveis de entrega do provedor sem manter o
estado pendente indefinidamente. Um worker agendado (`ProcessPendingReferences`)
busca as transações com retry devido (`isReferenceRetryDue`) e tenta resolver a
referência de novo. Esgotado o limite (`hasExhaustedReferenceRetries`), a
transação vai para `REJECTED` com `failureCode: REFERENCE_NOT_FOUND` e o evento
correspondente é publicado.

## 8. Mapeamento de erro para HTTP

| Situação | Status | Corpo |
|---|---|---|
| Payload inválido (contrato) | 400 | erro de validação |
| `Idempotency-Key` repetida, payload diferente | 409 | conflito de idempotência |
| Transação nova, processada | 201 | `status: PROCESSED`, `idempotentReplay: false` |
| Replay idempotente | 200 | resultado original, `idempotentReplay: true` |
| Aceita, aguardando referência | 202 | `status: PENDING_REFERENCE` |
| Rejeição por regra de negócio | 422 | `status: REJECTED`, `failureCode` |
| Falha transitória de infraestrutura | 503 | `status: FAILED`, `failureCode` |

A distinção existe porque cada status pede uma reação diferente do provedor:
400/409 não devem ser reenviados sem correção; 422 é uma decisão de negócio
definitiva; 503 deve ser reenviado (a operação não foi decidida).

## 9. Taxonomia de `failureCode`

| Código | Quando |
|---|---|
| `INSUFFICIENT_BALANCE` | `BET` rejeitado por saldo insuficiente |
| `REVERSAL_INSUFFICIENT_BALANCE` | `ROLLBACK`/`REFUND` que deixaria saldo negativo — distinto do anterior porque é uma reversão contábil, não uma aposta nova |
| `CURRENCY_MISMATCH` | moeda da operação diferente da moeda da wallet |
| `REFERENCE_MISMATCH` | referência resolvida mas provider/player/wallet/round divergem |
| `REFERENCE_ALREADY_REVERSED` | referência já tem `REFUND`/`ROLLBACK` processado do mesmo tipo |
| `REFERENCE_NOT_FOUND` | `PENDING_REFERENCE` esgotou tentativas/TTL |
| `WALLET_NOT_FOUND` | `walletId` do payload não corresponde a nenhuma wallet existente |
| `INVALID_TRANSACTION_STATE` | transição inválida sobre transação terminal (erro de programação/uso indevido) |
| `PROCESSING_FAILED` | erro permanente de infraestrutura detectado após esgotar retries (usado ao marcar `FAILED` antes de rotear para DLQ) |

## 10. Autenticação — Keycloak

Integração real com um Identity Provider externo (Keycloak via Docker Compose,
realm provisionado por import), não autenticação artesanal. A API valida o JWT
(RS256) recebido em `Authorization: Bearer`, verificando a assinatura contra a
JWKS pública do realm (`node:crypto`, sem biblioteca de JWT — mesmo padrão já
usado para HS256 em outros projetos, aqui adaptado para verificação RS256 nativa)
e o `AuthGuard` é aplicado globalmente, exceto em `/health/*` e no consumidor SQS
(canal interno confiável). A identidade do provedor contida na mensagem da fila
continua sujeita às validações de domínio normais.

## 10.1 MikroORM fora do ciclo HTTP — `RequestContext` explícito

O middleware do `@mikro-orm/nestjs` cria um `RequestContext` (EntityManager
forkado) automaticamente para cada requisição HTTP, mas isso não cobre nada
que rode fora de uma requisição — o consumidor SQS e os dois schedulers
(`OutboxPublisherScheduler`, `PendingReferenceScheduler`). Sem um contexto
ativo, o MikroORM recusa operações no EntityManager global (proteção contra
identity map compartilhado entre execuções concorrentes). Por isso, todo
ponto de entrada em background chama
`runInDbContext(orm, fn)` (`src/infrastructure/persistence/mikro-orm/run-in-context.ts`,
que envolve `RequestContext.create`) antes de tocar qualquer repositório ou
`UnitOfWork.run` — replicando manualmente o que o middleware HTTP faz de
graça para requisições.

## 10.2 Docker Compose — três instâncias

`docker-compose.yml` sobe `postgres`, `localstack`, `keycloak`, um serviço
`migrate` (roda as migrations uma vez e sai) e três instâncias da aplicação
(`app1`/`app2`/`app3`, portas `3001`-`3003`) apontando para o mesmo Postgres —
existência física de múltiplas instâncias para o requisito da seção 8, não
só teste simulado em processo único. `Dockerfile` tem três estágios: `deps`
(só dependências de produção), `build` (gera o bundle com `bun run build` —
ver §12.3 para os dois `--external` necessários) e `runtime`, em
`oven/bun:1-slim`, que roda `bun run dist/main.js`. `src/` ainda vai junto na
imagem porque o serviço `migrate` sobrescreve o `CMD` para rodar
`scripts/migrate.ts`, que importa a config do MikroORM direto do
código-fonte, não do bundle.

## 10.3 Distribuição de carga REST — por que só o SQS não basta

As três instâncias resolvem sozinhas o lado do consumo de fila: `wager-transactions.fifo`
usa o padrão *competing consumers* — cada instância roda seu próprio poller
(`sqs-consumer`) sobre a mesma fila, e o SQS entrega cada mensagem a exatamente
um poller por vez (respeitando o `MessageGroupId` da fila FIFO). Não existe
"escolher" instância nesse lado: é inerente ao modelo de fila.

O lado REST é diferente. Sem um componente na frente das três instâncias, um
cliente HTTP precisaria escolher manualmente `3001`, `3002` ou `3003` — o que
não é distribuição, é seleção manual, e não sobrevive à perda de uma
instância. `nginx` entra como reverse proxy round-robin
(`deploy/nginx/nginx.conf`), ouvindo em `3000` e distribuindo entre
`app1:3000`/`app2:3000`/`app3:3000` na rede interna do compose. Ele só começa
a rotear depois que as três instâncias respondem `service_healthy` no
healthcheck (`bun -e "fetch('http://localhost:3000/health/live')..."`,
já que a imagem `oven/bun:1-slim` não tem `curl`) — do contrário o nginx
enviaria tráfego para uma instância ainda subindo o Nest.

`proxy_next_upstream off` é deliberado: se uma instância falhar no meio de uma
escrita, o nginx **não** reencaminha a mesma requisição para outra instância.
Reencaminhar automaticamente arrisca reexecutar um `POST` cujo efeito colateral
já pode ter ocorrido antes da falha aparente (timeout de rede na resposta, não
necessariamente antes do commit) — a decisão de reenviar é do provedor, via o
mesmo `Idempotency-Key`, não do proxy. Round-robin simples (sem *sticky
session* por wallet) é suficiente porque a unidade de concorrência é resolvida
no Postgres (lock por linha da wallet, §8), não na camada HTTP — não importa
qual das três instâncias recebe a requisição.

As portas `3001`-`3003` continuam publicadas diretamente no host, além do
`3000` do nginx: a verificação manual de consistência entre instâncias
(§10.2) depende de bater em cada uma individualmente, e fica disponível para
quem quiser isolar uma instância específica em debug pontual — o teste de
carga (`bun run test:load`), por padrão, aponta para o `3000` (nginx), não
para uma porta individual (ver §13: o lock medido é uma linha do Postgres,
não algo do processo Node, então passar pelo proxy não distorce a medição e
ainda exercita as três instâncias sob tráfego HTTP real).

## 11. Gate de cobertura — particularidades do `bun test`

O padrão da casa pede cobertura de linha **e branch** em 100% no núcleo. O
`bun test` (v1.4.x) só reporta e só aplica `coverageThreshold` sobre `lines` e
`functions` — não existe uma métrica de branch separada. Mitigação: os testes
de `domain/` e `application/` cobrem explicitamente os ramos de decisão
(por tipo de operação, por status, por resultado de validação — não só a
"linha feliz"), então a cobertura de linha em 100% aqui é, na prática, também
cobertura de branch, mesmo sem a métrica separada existir na ferramenta.

Duas armadilhas de configuração do `bunfig.toml` que vale registrar (pagas
durante o desenvolvimento, para não repetir):

- A chave é `coverageThreshold = { lines = 1.0, functions = 1.0 }`
  (plural). `{ line, function }` no singular é aceito silenciosamente pelo
  parser TOML e simplesmente nunca é aplicado — o gate parece existir mas
  nunca falha. Validado forçando uma branch sem teste e conferindo o exit code.
- `coveragePathIgnorePatterns` precisa de glob (`"test/**"`), não prefixo de
  caminho (`"test/"`) — com prefixo simples, o padrão não casa e os arquivos
  de suporte de teste (fakes/mocks) acabam entrando na métrica e podem
  derrubar o gate por um arquivo que não faz parte do núcleo.

Cobertura do Bun também só existe para arquivos efetivamente importados durante
a execução dos testes — não há um modo "all files" (como o `all: true` do
Istanbul) que force a aparição de um arquivo nunca importado por nenhum teste.
Mitigação: todo arquivo novo em `domain/`/`application/` ganha teste no mesmo
commit; não há verificação automatizada de "arquivo esquecido".

## 12.1 Validado contra infraestrutura real

`test/integration` (13 testes) e `test/concurrency` (6 testes) rodaram verdes
contra Postgres e LocalStack reais em container (`testcontainers`) — não é
uma afirmação sem verificação, foi executado. Cobre: cenário obrigatório da
seção 8 (duas apostas de 80 contra saldo de 100 → uma `PROCESSED`, uma
`REJECTED`, saldo final 20, um débito), 50 requisições idênticas em paralelo
→ um único débito, 3 instâncias reais (conexões independentes) disputando a
mesma wallet e wallets diferentes em paralelo, `REFUND` entregue antes da
`BET` (e sem a referência nunca chegar), dois publishers concorrentes na
mesma outbox sem duplicar nem perder mensagem, publish real numa fila FIFO do
LocalStack, e as quatro garantias de schema (unique de wallet, `CHECK` de
saldo, trigger de imutabilidade do ledger, índice único parcial de reversão).
`RequestContext.create` manual para jobs em background (§10.1) também foi
confirmado nesse processo — o consumidor SQS e os schedulers não lançam erro
de "global EntityManager instance".

Dois bugs reais foram encontrados e corrigidos só porque esses testes rodaram
contra Postgres de verdade (nenhum teste unitário com mock os pegava, porque
os fakes em memória não têm FK nem constraint única):

- **Ordem de escrita em `apply-transaction-effects.ts`**: o lançamento do
  ledger era salvo antes da própria `WagerTransaction`, violando a FK
  `wallet_ledger_entries.transaction_id → wager_transactions(id)` (não
  adiável). Corrigido invertendo a ordem: wallet → transação → ledger.
- **Corrida de idempotência sob INSERT concorrente**: com 50 requisições
  idênticas em paralelo, a checagem inicial (`findByIdempotencyKey`) não vê
  nada em nenhuma das 50 antes de qualquer commit — cada uma tenta inserir
  sua própria `WagerTransaction`, só uma vence a constraint única do banco, e
  as outras 49 recebiam a exceção crua do driver em vez de um replay
  gracioso. Corrigido com `IdempotencyRaceLostError`: o repositório traduz a
  violação de unicidade nesse erro tipado, e `SubmitWagerTransaction.execute`
  o captura e busca de novo por `idempotencyKey` — a vencedora já está
  commitada nesse ponto (é por isso que a constraint disparou), então a
  busca sempre a encontra e devolve como replay.

`docker compose up -d --build` também subiu a stack completa de verdade —
Postgres, LocalStack, Keycloak, `migrate` e as três instâncias da aplicação
(`app1`/`app2`/`app3`) — e o fluxo completo foi exercitado manualmente:
token real do Keycloak → `POST /wallets` na instância 1 → `POST
/wagering/transactions` (BET) na instância 2 → replay idempotente da mesma
`Idempotency-Key` também na instância 2 → `GET /wallets/:id` na instância 3
vendo o saldo atualizado — prova de que as três instâncias realmente
compartilham o mesmo estado via Postgres, não é um teste dentro de um único
processo. `/health/ready` reporta `postgres` e `sqs` verdadeiros nas três
instâncias, e `/docs` serve o Swagger/OpenAPI gerado pelo NestJS. Três bugs
adicionais só apareceram rodando a stack completa (nenhum teste automatizado
tocava esse caminho):

- **`Dockerfile` não copiava `scripts/`**: o `migrate` (que roda
  `scripts/migrate.ts` dentro do container) falhava com "Module not found".
  Também faltava copiar `bunfig.toml` para o estágio de `deps` — sem ele, o
  `bun install` dentro da imagem usa o linker padrão e reintroduz o problema
  do `ajv` do item abaixo. Corrigido copiando os dois.
- **Script de init do LocalStack quebrava no meio**: `--attributes` do
  `awslocal sqs create-queue` em formato shorthand não aceita o valor JSON
  aninhado de `RedrivePolicy` (o parser se perde no `{`). A fila DLQ era
  criada, a fila principal não. Corrigido gerando um arquivo JSON completo de
  atributos e passando `--attributes file://...` em vez do shorthand.
- **Login no Keycloak falhava com "Account is not fully set up"** mesmo com
  `requiredActions: []` no usuário — o Keycloak 26 tem "Verify Profile" como
  ação implícita quando o perfil do usuário não tem `email`/`firstName`/
  `lastName` preenchidos (User Profile declarativo, habilitado por padrão).
  Corrigido preenchendo esses campos no `realm-export.json`. Separadamente,
  o token de um client público sem mapper de audience não carrega `aud`
  nenhum nas versões recentes do Keycloak — o `KeycloakJwtVerifier` rejeitava
  com "audience inválida"; corrigido adicionando um `oidc-audience-mapper`
  explícito no client apontando para `wagering-api` (e ajustando
  `KEYCLOAK_AUDIENCE` de `account` para `wagering-api`).
- **`wallets.version` era `bigint` na migration mas `number` na entidade**:
  o driver do Postgres retorna colunas `bigint` como string (para não perder
  precisão em inteiros de 64 bits que o JS não representa com segurança), e
  como a entidade declara `number`, essa string vazava sem conversão até o
  JSON da API (`"version": "2"` em vez de `"version": 2`). Corrigido
  trocando a coluna para `integer` na migration — versão de wallet nunca
  precisa de 64 bits.

## 12.2 Armadilhas de ambiente (Bun + Windows) pagas durante o desenvolvimento

- **`bun install` (linker padrão "hoisted") resolve mal um conflito real de
  `ajv`**: `eslint` quer `ajv@^6`, e `ajv-draft-04` (transitivo de
  `@mikro-orm/migrations` via `umzug` → `@rushstack/*`) quer `ajv@^8`.
  `ajv-draft-04` fica sem `node_modules` aninhado próprio e a resolução sobe
  até achar o `ajv@6` do topo, que não tem `ajv/dist/core` — `MikroORM.init()`
  falha com `Cannot find module 'ajv/dist/core'` mesmo sem tocar em
  migrations. Fix: `[install] linker = "isolated"` no `bunfig.toml` (dá a
  cada pacote sua própria resolução, como o `node-modules` isolado do pnpm).
- **`@mikro-orm/cli` não funciona bem neste ambiente**: o binário do CLI no
  Windows sobe um processo Node separado (não herda o Bun), e o loader ESM do
  Node quebra em caminho absoluto do Windows
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) ao carregar `mikro-orm.config.ts`. Fix:
  `scripts/migrate.ts` chama a API do MikroORM (`MikroORM.init` +
  `orm.migrator.up()/.down()`) direto dentro do processo Bun — sem CLI,
  sem loader externo. `migration:create` continua apontando para o CLI (não
  usado nesta entrega; se precisar gerar uma migration nova, espere o mesmo
  problema e considere escrevê-la à mão como a inicial).
- Config de migrations usa `migrationsList` (import estático da classe) em
  vez de scan de pasta — o scan dinâmico de `.ts` também aciona detecção de
  loader (mesma família de problema do CLI).
- **MikroORM 7 tirou os decorators (`@Entity`, `@Property`, `@PrimaryKey`,
  `@Unique`, `@Index`, `@Enum`) do `@mikro-orm/core`** — agora moram no
  pacote separado `@mikro-orm/decorators`, em `@mikro-orm/decorators/legacy`
  (estilo decorator clássico, usado aqui) ou `@mikro-orm/decorators/es`
  (novo decorator spec do TC39). Junto disso, o core parou de registar a
  inferência de tipo via `reflect-metadata` por padrão — toda `@Property()`
  sem `type` explícito passou a falhar a descoberta de metadados
  ("Please provide either 'type' or 'entity' attribute"). Fix: instalar
  `@mikro-orm/decorators`, trocar os imports dos 5 arquivos de entidade, e
  registrar `metadataProvider: ReflectMetadataProvider` (também de
  `@mikro-orm/decorators/legacy`) na config do ORM — restaura a inferência
  automática em vez de anotar `type` em toda propriedade simples.
- **`MikroORM.getMigrator()` virou `MikroORM.migrator`** (getter, não
  método) no v7 — afeta `scripts/migrate.ts` e o harness de testes de
  integração (`test/integration/support/test-database.ts`).

## 12.3 `bun build` — resolvido

Tentar bundlar (`bun build ./src/main.ts --target=bun`) direto quebrava de
duas formas, ambas resolvidas:

- O Nest carrega `@nestjs/microservices` e `@nestjs/websockets` via
  `import()` dinâmico só se o app realmente usar (nenhum dos dois está
  instalado aqui, de propósito — este serviço é só HTTP). O bundler tenta
  resolver esses `import()` estaticamente e falha. Fix: `--external
  @nestjs/microservices --external @nestjs/websockets`.
- `@nestjs/swagger` resolve o caminho dos assets estáticos do Swagger UI
  (HTML/CSS/fonts) via `require.resolve('swagger-ui-dist/...')` em runtime —
  um bundle carrega só a lógica JS, não esses arquivos. Fix:
  `--external swagger-ui-dist` **e** adicionar `swagger-ui-dist` como
  dependência direta (com `linker = "isolated"`, um pacote só é resolvível
  fora de quem o declara se ele também aparecer no `package.json` de quem
  vai fazer o `require`).

Com os dois fixes, `bun run build` gera um `dist/main.js` de ~6MB que sobe
normalmente (decorators e DI sobrevivem ao bundle) e responde a requisições
reais, testado manualmente contra Postgres/LocalStack/Keycloak reais. O
`Dockerfile` agora tem um estágio `build` dedicado e a imagem final roda
`bun run dist/main.js` (não mais a partir do código-fonte) — ver §10.2.

## 12.4 Limitações conhecidas

- **Sem OpenTelemetry (tracing distribuído)** — explicitamente opcional no
  enunciado (seção 12). Dashboard (Grafana + Prometheus) existe — ver §12.6.
- **Sem ledger de partidas dobradas (double-entry bookkeeping)** —
  explicitamente diferencial opcional (seção 6.4), não requisito.
- **WIN com `referenceExternalTransactionId` opcional**: quando informado, o
  sistema tenta resolver o link para auditoria mas não bloqueia nem rejeita o
  processamento se a referência não existir (não vira `PENDING_REFERENCE`,
  diferente de `REFUND`/`ROLLBACK`) — interpretação adotada porque a seção 7
  só define o fluxo de referência obrigatória para esses dois tipos;
  documentada aqui conforme pedido no enunciado.

## 12.5 `WagerTransactionConsumer` contra SQS e Postgres reais

Até certo ponto do desenvolvimento, `WagerTransactionConsumer` (o adapter que
consome `wager-transactions.fifo`) nunca tinha sido instanciado por nenhum
teste — a suíte cobria o mesmo comportamento só indiretamente, via
`ConsumeWagerTransactionMessage` com fakes em memória (inbox e redelivery) e
via inspeção de código (retry/DLQ, `SIGTERM`). Isso deixava a seção 13 do
enunciado (inbox e redelivery, retry, DLQ, crash recovery e shutdown "contra
Postgres e LocalStack reais") parcialmente descoberta: os fakes provam a
lógica do use case, não o comportamento real de `ReceiveMessage`/
`DeleteMessageCommand`/redrive policy que só existe na integração com o SQS
de verdade.

`test/integration/sqs-consumer.integration.test.ts` fecha essa lacuna
instanciando a classe real contra containers reais, sem substituir nem
Postgres nem LocalStack por mock — só um repositório é envolvido por um
decorator de injeção de falha (`FlakyWalletRepository`/`SlowWalletRepository`),
técnica de teste de fault injection, não de mock da infraestrutura. Cobre:
consumo e ack reais, redelivery deduplicada pelo inbox, conflito de
`Idempotency-Key` com payload diferente, falha transitória com recuperação
por uma segunda instância após expirar a visibilidade, esgotamento do
`maxReceiveCount` movendo a mensagem para a DLQ, e `onModuleDestroy`
(SIGTERM) esperando a mensagem em andamento terminar antes de resolver.

Para viabilizar isso sem inflar os tempos de teste, `VisibilityTimeout` e
`WaitTimeSeconds` (antes fixos em 30s/5s dentro de `pollOnce`) viraram
parâmetros opcionais do construtor, com os mesmos valores como default —
produção não muda, os testes de retry/DLQ passam a rodar em segundos em vez
de minutos.

Dois problemas reais só apareceram ao escrever esses testes:

- **`ReceiveMessageCommand` com `VisibilityTimeout: 0` não é um "peek"
  confiável no LocalStack** — o valor explícito `0` parece cair no default
  da fila (não configurado, portanto os 30s de produção) em vez de manter a
  mensagem imediatamente visível, então uma checagem de "fila vazia?" via
  receive sequestrava a própria mensagem que o teste queria observar sendo
  processada por outra instância. Corrigido usando
  `GetQueueAttributesCommand` (`ApproximateNumberOfMessages` +
  `ApproximateNumberOfMessagesNotVisible`) para checar o estado da fila sem
  consumir nada.
- **`bunfig.toml` com `coverage = true` no `[test]` aplicava o
  `coverageThreshold` de 100% a qualquer invocação de `bun test`, inclusive
  `bun run test:integration` e `bun run test:concurrency`** — que rodam só um
  subconjunto de `domain/`+`application/` (não é o papel deles chegar a
  100%, isso é do `test:coverage`) e por isso sempre terminavam com exit code
  1 mesmo com todos os testes passando. `bun test:integration (7 testes) e
  bun test:concurrency (6 testes) rodam verdes` (texto anterior deste
  documento e do README) descrevia os testes, não o exit code real do
  comando — um CI que checasse o exit code desses scripts falharia sempre.
  Corrigido comentando `coverage = true` no `bunfig.toml`; `test:coverage`
  continua gatendo 100% porque passa `--coverage` explicitamente na CLI, que
  reativa a coleta (e o `coverageThreshold`) só para aquele script.

## 12.6 Métricas mínimas e dashboard — do comentário morto ao dado real

`Metrics` (`src/application/ports/metrics.port.ts`) sempre teve um comentário
listando a exigência da seção 12 do enunciado: "métricas mínimas exigidas:
status de transações, duplicatas, retries, DLQ, locks, outbox lag, latência".
Em algum ponto do desenvolvimento, só duas dessas sete existiam de verdade
(`wager_transactions_consumed_total` e `wallet_reconciliation_divergence_total`)
— o comentário descrevia uma intenção, não o estado real do código, e um
dashboard construído em cima disso teria ficado majoritariamente vazio. As
cinco que faltavam foram fechadas:

- **Status de transações** (`wager_transactions_total{channel,status}`):
  instrumentado na borda — `WageringController` (canal HTTP) e
  `WagerTransactionConsumer` (canal SQS) — não dentro de
  `SubmitWagerTransaction`, que é código de domínio/aplicação compartilhado
  pelos dois canais e não deveria saber por qual chegou. Isso exigiu
  `ConsumeWagerTransactionMessage.execute` parar de descartar o resultado de
  `SubmitWagerTransaction` (retornava `void`) e passar a devolver
  `{ duplicateDelivery, submitResult }`.
- **Duplicatas detectadas**: `wager_transactions_replays_total` (mesma
  `Idempotency-Key`, replay) nas duas bordas, mais
  `wager_transactions_duplicate_deliveries_total` (redelivery do SQS
  deduplicada pelo inbox antes mesmo de tocar `SubmitWagerTransaction`).
- **Retries**: `wager_transactions_retries_total{reason}` — erro transitório
  no consumidor SQS, nova tentativa de referência pendente
  (`ProcessPendingReferences`) e falha de publicação na outbox
  (`PublishOutboxBatch`), cada um com seu `reason`.
- **Conflitos de lock**: `wager_transactions_lock_conflicts_total`, no ponto
  exato onde `SubmitWagerTransaction` já captura a corrida de idempotência
  sob `INSERT` concorrente (`IdempotencyRaceLostError`, ver §12.1) — a
  métrica só formaliza um caso que o código já tratava corretamente.
- **DLQ**: o processo nunca vê uma mensagem sendo movida para a DLQ — é o
  broker que decide isso, sem notificar o consumidor. A única forma honesta
  de observar profundidade de DLQ é perguntar à fila por fora do fluxo de
  consumo: `DlqDepthScheduler` (mesmo padrão `setInterval` do
  `OutboxPublisherScheduler`) faz `GetQueueAttributesCommand` a cada 10s e
  publica `wager_transactions_dlq_depth` como gauge.
- **Outbox lag**: `outbox_publish_lag_ms` (histograma), calculado em
  `PublishOutboxBatch` como `publishedAt - occurredAt` no momento em que a
  mensagem é marcada publicada — o tempo real entre o evento acontecer e sair
  para o SQS, não uma aproximação.
- **Latência de processamento**: `wager_transaction_processing_duration_ms`
  (histograma, por canal), medido nas duas bordas ao redor da chamada a
  `SubmitWagerTransaction`/`ConsumeWagerTransactionMessage`.

Threading `Metrics` por `SubmitWagerTransaction`, `ProcessPendingReferences`
e `PublishOutboxBatch` — os três em `application/`, sob o gate de cobertura
100% — significava um novo parâmetro de construtor obrigatório em cada um.
Antes de fazer isso, foi confirmado que cada classe tem exatamente um ponto
de construção por arquivo de teste (um `buildSut()`/`buildHarness()`
reaproveitado por todos os `it()`, nunca instanciação repetida por teste) —
o raio de mudança real era 5 arquivos de teste por classe, não dezenas.
`FakeMetrics` (suporte de teste) passou a gravar histogramas e gauges de
verdade (`histogramObservations`, `gauges`) em vez de descartá-los — sem
isso, não haveria como testar que `observeHistogram`/`setGauge` foram
chamados com os valores certos.

**Dashboard**: `docker-compose.yml` ganhou `prometheus` (scrape a cada 5s,
direto em `app1:3000`/`app2:3000`/`app3:3000` — não via `nginx`, porque o
label `instance` por trás do load balancer precisa continuar distinguindo as
três) e `grafana` (`http://localhost:3100`, `admin`/`admin`, também com
acesso anônimo de leitura), com datasource e dashboard provisionados
automaticamente (`deploy/grafana/provisioning/`,
`deploy/grafana/dashboards/wagering-processor.json`) — sobe pronto, sem
configuração manual. Validado de ponta a ponta contra a stack real: os 3
alvos do Prometheus `up`, tráfego gerado via `bun run test:load`, e as
mesmas expressões PromQL dos 11 painéis do dashboard consultadas direto
pela API do Prometheus e pelo proxy de query do próprio Grafana — os dois
devolvendo dado real, não apenas a definição do painel carregando.

## 13. Teste de carga (diferencial opcional)

`bun run test:load` (`test/load/run.ts`) sobe uma carga sintética contra a
stack completa já rodando (`docker compose up`) — cria um pool de wallets com
saldo alto e dispara `BET`s concorrentes até estourar a duração configurada
(`LOAD_CONCURRENCY`, `LOAD_DURATION_SECONDS`, `LOAD_WALLET_POOL_SIZE`).

**Ambiente**: as 3 instâncias reais (`app1`/`app2`/`app3`) atrás do `nginx`
(`http://localhost:3000`, round-robin — §10.3), não uma instância isolada.
O lock que está sendo medido é uma linha do Postgres (§4), não algo local ao
processo Node, então passar pelo load balancer não distorce a comparação
entre os cenários de contenção abaixo — e é a única forma de o teste também
exercitar as 3 instâncias recebendo tráfego HTTP concorrente de verdade
(seção 8), em vez de só uma. Cliente e servidores competem pela mesma
máquina, então os números abaixo são um piso de latência, não um teto de
capacidade. Postgres, LocalStack e Keycloak reais no mesmo `docker compose`.

**Metodologia**: dois experimentos, 20 workers concorrentes em ambos —
(1) pool de 20 wallets (baixa contenção, cada worker majoritariamente bate em
wallets diferentes) e (2) pool de 2 wallets (alta contenção, todos os workers
disputam as duas mesmas linhas). Cada `BET` usa um `externalTransactionId`
novo (sem idempotência envolvida — throughput de transações novas, não de
replay). Saldo inicial das wallets é alto o bastante para nunca esgotar
durante o teste, isolando o efeito da contenção de lock do efeito de
rejeição por saldo insuficiente (esse segundo cenário já é coberto pelos
testes de concorrência automatizados da seção 8).

**Resultados**:

| Cenário | Requisições | Throughput | p50 | p95 | p99 | máx | Erros |
|---|---|---|---|---|---|---|---|
| 20 wallets (baixa contenção) | 5129 | 255.9 req/s | 67.4ms | 163.5ms | 242.3ms | 445.1ms | 0 |
| 2 wallets (alta contenção) | 3908 | 194.7 req/s | 45.4ms | 403.3ms | 725.3ms | 2109.6ms | 0 |

**Leitura honesta**: zero erros e zero rejeições nos dois cenários — o
saldo nunca chegou perto de zero, de propósito, para isolar só o efeito da
contenção de lock. Esse efeito aparece claramente na cauda, agora com 3
instâncias reais recebendo as requisições via round-robin: p95 mais que
dobra (163.5ms → 403.3ms) e p99 quase triplica (242.3ms → 725.3ms) quando 20
workers disputam 2 linhas em vez de 20 — é o lock pessimista de linha (§4)
serializando escritas na mesma wallet no Postgres, não algo que o nginx ou
qualquer instância individual poderia mascarar. Throughput caiu ~24% apesar
da contenção 10x maior. O p50 mais baixo no cenário de alta contenção
(67.4ms → 45.4ms) é contraintuitivo à primeira vista; não foi investigado a
fundo (são duas execuções separadas, não um A/B controlado, e variância de
máquina compartilhada é uma explicação plausível) — reportado como está, sem
inventar uma causa, porque a métrica que realmente importa aqui (a cauda
alongando sob contenção) é inequívoca nos dois testes.

**Outbox lag e conflitos de lock durante esta carga**: agora existem como
métrica real (`outbox_publish_lag_ms`, `wager_transactions_lock_conflicts_total`
— ver §12.6) e ficam visíveis no dashboard Grafana
(`http://localhost:3100`) durante a execução do teste — não foram
capturados aqui porque este script mede o que o cliente HTTP observa
(throughput e latência de resposta), não métricas internas do servidor; o
dashboard é o lugar certo para olhar isso, não duplicado em texto aqui. Não
há meta de RPS definida; o objetivo era caracterizar o comportamento sob
contenção, não maximizar um número.
