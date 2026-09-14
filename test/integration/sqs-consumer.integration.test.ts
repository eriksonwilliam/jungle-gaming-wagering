import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CryptoIdGenerator } from "../../src/infrastructure/adapters/crypto-id-generator.adapter";
import { SystemClock } from "../../src/infrastructure/adapters/system-clock.adapter";
import { WagerTransactionConsumer } from "../../src/infrastructure/messaging/sqs/wager-transaction.consumer";
import { runInDbContext } from "../../src/infrastructure/persistence/mikro-orm/run-in-context";
import { MikroOrmInboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/inbox.repository";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/ledger.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/outbox.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/wager-transaction.repository";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/wallet.repository";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/unit-of-work.adapter";
import type { WalletRepository } from "../../src/application/ports/wallet-repository.port";
import { ConsumeWagerTransactionMessage } from "../../src/application/use-cases/consume-wager-transaction-message.use-case";
import { CreateWallet } from "../../src/application/use-cases/create-wallet.use-case";
import { SubmitWagerTransaction } from "../../src/application/use-cases/submit-wager-transaction.use-case";
import type { Wallet } from "../../src/domain/wallet/wallet";
import { FakeLogger, FakeMetrics } from "../unit/application/support/fakes";
import { startTestDatabase, type TestDatabase } from "./support/test-database";

/**
 * Testa `WagerTransactionConsumer` de verdade — Postgres e LocalStack reais
 * em container, sem substituir nenhum dos dois por mock. Os outros testes de
 * integração/concorrência exercitam os use cases diretamente; este arquivo é
 * o único que instancia a classe do consumidor SQS em si, cobrindo os itens
 * da seção 13 que dependem do comportamento do próprio adapter: inbox e
 * redelivery, retry transitório, DLQ e encerramento gracioso (SIGTERM).
 */

let db: TestDatabase;
let localstackContainer: StartedTestContainer;
let sqsClient: SQSClient;

beforeAll(async () => {
  db = await startTestDatabase();

  localstackContainer = await new GenericContainer("localstack/localstack:3")
    .withEnvironment({ SERVICES: "sqs" })
    .withExposedPorts(4566)
    .withWaitStrategy(Wait.forLogMessage(/Ready\./, 1))
    .start();

  const endpoint = `http://${localstackContainer.getHost()}:${localstackContainer.getMappedPort(4566)}`;
  sqsClient = new SQSClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}, 60_000);

afterAll(async () => {
  sqsClient.destroy();
  await localstackContainer.stop();
  await db.stop();
});

/** Fila FIFO nova por teste — evita mensagem de um teste vazar para outro. */
async function createFifoQueue(): Promise<string> {
  const name = `wager-transactions-${randomUUID()}.fifo`;
  const { QueueUrl } = await sqsClient.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true" } }));
  return QueueUrl as string;
}

async function createFifoQueueWithDlq(maxReceiveCount: number): Promise<{ queueUrl: string; dlqUrl: string }> {
  const dlqName = `wager-transactions-dlq-${randomUUID()}.fifo`;
  const { QueueUrl: dlqUrl } = await sqsClient.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: "true" } }));
  const { Attributes } = await sqsClient.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl as string, AttributeNames: ["QueueArn"] }),
  );
  const dlqArn = Attributes!.QueueArn as string;

  const name = `wager-transactions-${randomUUID()}.fifo`;
  const { QueueUrl } = await sqsClient.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: "true",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount }),
      },
    }),
  );
  return { queueUrl: QueueUrl as string, dlqUrl: dlqUrl as string };
}

interface SendBetOptions {
  messageId?: string;
  idempotencyKey?: string;
  externalTransactionId?: string;
  walletId: string;
  playerId: string;
  amount?: string;
}

async function sendBetMessage(queueUrl: string, options: SendBetOptions): Promise<void> {
  const externalTransactionId = options.externalTransactionId ?? randomUUID();
  const body = {
    messageId: options.messageId ?? randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: options.idempotencyKey ?? `provider-a:${externalTransactionId}`,
      playerId: options.playerId,
      walletId: options.walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: options.amount ?? "10.00", currency: "BRL" },
    },
  };
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: options.walletId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

/** Decorator de falha injetada — envolve o repositório real, não o substitui. */
class FlakyWalletRepository implements WalletRepository {
  private remainingFailures: number;

  constructor(
    private readonly real: WalletRepository,
    failures: number,
  ) {
    this.remainingFailures = failures;
  }

  findById(id: string): Promise<Wallet | undefined> {
    return this.real.findById(id);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("falha transitória simulada de infraestrutura");
    }
    return this.real.findByIdForUpdate(id);
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.real.findByPlayerAndCurrency(playerId, currency);
  }

  save(wallet: Wallet): Promise<void> {
    return this.real.save(wallet);
  }
}

class SlowWalletRepository implements WalletRepository {
  constructor(
    private readonly real: WalletRepository,
    private readonly delayMs: number,
  ) {}

  findById(id: string): Promise<Wallet | undefined> {
    return this.real.findById(id);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.real.findByIdForUpdate(id);
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.real.findByPlayerAndCurrency(playerId, currency);
  }

  save(wallet: Wallet): Promise<void> {
    return this.real.save(wallet);
  }
}

interface Harness {
  consumer: WagerTransactionConsumer;
  walletRepository: WalletRepository;
  wagerTransactionRepository: MikroOrmWagerTransactionRepository;
  createWallet: CreateWallet;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

function buildHarness(
  queueUrl: string,
  opts: { walletRepository?: (real: WalletRepository) => WalletRepository; visibilityTimeoutSeconds?: number; waitTimeSeconds?: number } = {},
): Harness {
  const em = db.orm.em;
  const clock = new SystemClock();
  const idGenerator = new CryptoIdGenerator();
  const realWalletRepository = new MikroOrmWalletRepository(em);
  const walletRepository = opts.walletRepository ? opts.walletRepository(realWalletRepository) : realWalletRepository;
  const wagerTransactionRepository = new MikroOrmWagerTransactionRepository(em);
  const ledgerRepository = new MikroOrmLedgerRepository(em);
  const inboxRepository = new MikroOrmInboxRepository(em);
  const outboxRepository = new MikroOrmOutboxRepository(em);
  const unitOfWork = new MikroOrmUnitOfWork(db.orm);

  const submitWagerTransaction = new SubmitWagerTransaction(
    walletRepository,
    wagerTransactionRepository,
    ledgerRepository,
    outboxRepository,
    unitOfWork,
    clock,
    idGenerator,
  );
  const consumeWagerTransactionMessage = new ConsumeWagerTransactionMessage(inboxRepository, submitWagerTransaction, unitOfWork, clock);
  const consumer = new WagerTransactionConsumer(
    db.orm,
    sqsClient,
    queueUrl,
    consumeWagerTransactionMessage,
    new FakeLogger(),
    new FakeMetrics(),
    opts.visibilityTimeoutSeconds ?? 30,
    opts.waitTimeSeconds ?? 5,
  );

  return {
    consumer,
    walletRepository,
    wagerTransactionRepository,
    createWallet: new CreateWallet(realWalletRepository, wagerTransactionRepository, ledgerRepository, outboxRepository, unitOfWork, clock, idGenerator),
    run: (fn) => runInDbContext(db.orm, fn),
  };
}

async function receiveOne(queueUrl: string, waitTimeSeconds = 5): Promise<Message | undefined> {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: waitTimeSeconds }),
  );
  return response.Messages?.[0];
}

describe("WagerTransactionConsumer — SQS e Postgres reais", () => {
  it("consome uma mensagem real da fila, aplica no Postgres e dá ack (mensagem sai da fila)", async () => {
    const queueUrl = await createFifoQueue();
    const { consumer, createWallet, run } = buildHarness(queueUrl);
    const playerId = randomUUID();
    const { wallet } = await run(() => createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }));

    await sendBetMessage(queueUrl, { walletId: wallet.id, playerId, amount: "10.00" });

    consumer.onModuleInit();
    try {
      await waitUntil(() => queueIsEmpty(queueUrl), 10_000);
    } finally {
      await consumer.onModuleDestroy();
    }

    const finalWallet = await run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "90.00", currency: "BRL" });
  }, 20_000);

  it("mesma mensagem entregue duas vezes (redelivery) é deduplicada pelo inbox — processa uma única vez", async () => {
    const queueUrl = await createFifoQueue();
    const { consumer, createWallet, run } = buildHarness(queueUrl);
    const playerId = randomUUID();
    const { wallet } = await run(() => createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }));
    const messageId = randomUUID();

    await sendBetMessage(queueUrl, { walletId: wallet.id, playerId, amount: "10.00", messageId });

    const raw = await receiveOne(queueUrl, 10);
    expect(raw).toBeDefined();

    const handleMessage = (consumer as unknown as { handleMessage(message: Message): Promise<void> }).handleMessage.bind(consumer);
    await handleMessage(raw!);
    await handleMessage(raw!); // simula a mesma entrega recebida uma segunda vez

    const finalWallet = await run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "90.00", currency: "BRL" });
  }, 20_000);

  it("Idempotency-Key repetida com payload diferente é rejeitada (erro de negócio) e ainda assim recebe ack", async () => {
    const queueUrl = await createFifoQueue();
    const { consumer, createWallet, run } = buildHarness(queueUrl);
    const playerId = randomUUID();
    const { wallet } = await run(() => createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }));
    const idempotencyKey = `provider-a:${randomUUID()}`;

    await sendBetMessage(queueUrl, { walletId: wallet.id, playerId, amount: "10.00", idempotencyKey });

    consumer.onModuleInit();
    await waitUntil(() => queueIsEmpty(queueUrl), 10_000);

    // mesma idempotency key, payload diferente (valor da aposta muda) — conflito, não replay
    await sendBetMessage(queueUrl, { walletId: wallet.id, playerId, amount: "20.00", idempotencyKey });
    await waitUntil(() => queueIsEmpty(queueUrl), 10_000);
    await consumer.onModuleDestroy();

    const finalWallet = await run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "90.00", currency: "BRL" }); // só a primeira aposta aplicou
  }, 20_000);

  it("falha transitória: mensagem não é acked; expira a visibilidade e uma nova instância entrega com sucesso", async () => {
    const queueUrl = await createFifoQueue();
    const setup = buildHarness(queueUrl);
    const playerId = randomUUID();
    const { wallet } = await setup.run(() =>
      setup.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }),
    );

    await sendBetMessage(queueUrl, { walletId: wallet.id, playerId, amount: "10.00" });

    // "instância" 1: falha uma vez (infra transitória) e morre antes de conseguir uma segunda
    // tentativa. VisibilityTimeout de 3s é deliberadamente maior que a janela de 600ms em que
    // deixamos a instância viva — garante que ela não tenha uma segunda chance de se autocurar
    // (o que mascararia o teste: a mesma instância reprocessando não prova recuperação por
    // *outra* instância).
    const flaky = buildHarness(queueUrl, { walletRepository: (real) => new FlakyWalletRepository(real, 1), visibilityTimeoutSeconds: 3, waitTimeSeconds: 1 });
    flaky.consumer.onModuleInit();
    await sleep(600);
    await flaky.consumer.onModuleDestroy();

    const afterFailure = await setup.run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(afterFailure!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" }); // não aplicou nada ainda

    // espera a visibilidade de 3s expirar de verdade antes de tentar de novo — evita a corrida
    // de checar exatamente no limite da janela.
    await sleep(3000);

    // "instância" 2: a visibilidade já expirou, a mensagem é entregue de novo e desta vez processa
    const recovering = buildHarness(queueUrl, { waitTimeSeconds: 5 });
    recovering.consumer.onModuleInit();
    await waitUntil(() => queueIsEmpty(queueUrl), 10_000);
    await recovering.consumer.onModuleDestroy();

    const finalWallet = await setup.run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "90.00", currency: "BRL" });
  }, 30_000);

  it("esgotado o limite de tentativas, a mensagem é movida para a DLQ", async () => {
    const { queueUrl, dlqUrl } = await createFifoQueueWithDlq(1);
    const setup = buildHarness(queueUrl);
    const playerId = randomUUID();
    const { wallet } = await setup.run(() =>
      setup.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }),
    );

    await sendBetMessage(queueUrl, { walletId: wallet.id, playerId, amount: "10.00" });

    // falha sempre (erro permanente de infraestrutura do ponto de vista do consumidor)
    const alwaysFlaky = buildHarness(queueUrl, {
      walletRepository: (real) => new FlakyWalletRepository(real, Number.POSITIVE_INFINITY),
      visibilityTimeoutSeconds: 1,
      waitTimeSeconds: 1,
    });
    alwaysFlaky.consumer.onModuleInit();

    const dlqMessage = await waitForMessage(dlqUrl, 15_000);
    await alwaysFlaky.consumer.onModuleDestroy();

    expect(dlqMessage).toBeDefined();
    const body = JSON.parse(dlqMessage!.Body as string);
    expect(body.data.walletId).toBe(wallet.id);

    const finalWallet = await setup.run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" }); // nunca aplicou o débito
  }, 30_000);

  it("SIGTERM (onModuleDestroy) espera a mensagem em andamento terminar antes de encerrar", async () => {
    const queueUrl = await createFifoQueue();
    const slow = buildHarness(queueUrl, { walletRepository: (real) => new SlowWalletRepository(real, 1000) });
    const playerId = randomUUID();
    const { wallet } = await slow.run(() =>
      slow.createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" }, correlationId: "setup" }),
    );

    await sendBetMessage(queueUrl, { walletId: wallet.id, playerId, amount: "10.00" });

    slow.consumer.onModuleInit();
    await sleep(400); // dá tempo do poll pegar a mensagem e entrar no findByIdForUpdate (que está atrasado 1000ms)

    const destroyPromise = slow.consumer.onModuleDestroy();

    const midShutdownWallet = await slow.run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(midShutdownWallet!.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" }); // ainda em andamento

    await destroyPromise; // onModuleDestroy só resolve depois da mensagem em andamento terminar

    const finalWallet = await slow.run(() => new MikroOrmWalletRepository(db.orm.em).findById(wallet.id));
    expect(finalWallet!.balance.toJSON()).toEqual({ amount: "90.00", currency: "BRL" });
  }, 15_000);
});

/**
 * Checa a fila por atributo, não por `ReceiveMessage` — um "peek" via receive
 * com `VisibilityTimeout: 0` demonstrou ser pouco confiável no LocalStack (o
 * 0 parece cair no default da fila em vez de manter a mensagem visível),
 * sequestrando a mensagem da instância real que o teste quer observar.
 */
async function queueIsEmpty(queueUrl: string): Promise<boolean> {
  const { Attributes } = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Attributes?.ApproximateNumberOfMessages === "0" && Attributes?.ApproximateNumberOfMessagesNotVisible === "0";
}

async function waitForMessage(queueUrl: string, timeoutMs: number): Promise<Message | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await receiveOne(queueUrl, 2);
    if (message) return message;
  }
  return undefined;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
