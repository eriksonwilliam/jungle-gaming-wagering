import { randomUUID } from "node:crypto";

/**
 * Teste de carga simples contra a stack já rodando (via `docker compose up`)
 * — não substitui os testes de concorrência automatizados, é um experimento
 * manual para caracterizar throughput/latência. Ver ARCHITECTURE.md §13 para
 * metodologia e limites.
 *
 * Aponta para o `nginx` (3000) por padrão, não para uma instância isolada: o
 * lock que está sendo medido é uma linha do Postgres, não algo local ao
 * processo Node, então passar pelo load balancer não distorce a comparação
 * entre os cenários de contenção — e é o único jeito de o teste de carga
 * também validar as 3 instâncias reais recebendo tráfego HTTP concorrente de
 * verdade (seção 8), não só uma. Para isolar uma instância específica em
 * debug pontual, defina `LOAD_BASE_URL=http://localhost:3001`.
 */

const BASE_URL = process.env.LOAD_BASE_URL ?? "http://localhost:3000";
const KEYCLOAK_URL = process.env.LOAD_KEYCLOAK_URL ?? "http://localhost:8080";
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const DURATION_SECONDS = Number(process.env.LOAD_DURATION_SECONDS ?? 20);
const WALLET_POOL_SIZE = Number(process.env.LOAD_WALLET_POOL_SIZE ?? 20);
const WALLET_INITIAL_BALANCE = "1000000.00";
const BET_AMOUNT = "1.00";

interface RequestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  outcome: "processed" | "replay" | "rejected" | "error";
}

async function fetchToken(): Promise<string> {
  const response = await fetch(`${KEYCLOAK_URL}/realms/wagering/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "wagering-api",
      grant_type: "password",
      username: "provider-a",
      password: "provider-a",
    }),
  });
  if (!response.ok) {
    throw new Error(`falha ao obter token do Keycloak: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function createWalletPool(token: string, size: number): Promise<string[]> {
  const wallets: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const response = await fetch(`${BASE_URL}/wallets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: { amount: WALLET_INITIAL_BALANCE, currency: "BRL" },
      }),
    });
    if (!response.ok) {
      throw new Error(`falha ao criar wallet de setup: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id: string };
    wallets.push(body.id);
  }
  return wallets;
}

async function submitBet(token: string, walletId: string, playerId: string): Promise<RequestResult> {
  const externalTransactionId = randomUUID();
  const start = performance.now();
  try {
    const response = await fetch(`${BASE_URL}/wagering/transactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `load-test:${externalTransactionId}`,
      },
      body: JSON.stringify({
        providerId: "load-test",
        externalTransactionId,
        playerId,
        walletId,
        roundId: "load-round",
        gameId: "load-game",
        kind: "BET",
        money: { amount: BET_AMOUNT, currency: "BRL" },
      }),
    });
    const latencyMs = performance.now() - start;
    const outcome = response.status === 422 ? "rejected" : response.ok ? "processed" : "error";
    return { ok: response.ok, status: response.status, latencyMs, outcome };
  } catch {
    return { ok: false, status: 0, latencyMs: performance.now() - start, outcome: "error" };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

async function main(): Promise<void> {
  console.log(`Teste de carga — ${BASE_URL}`);
  console.log(`Concorrência: ${CONCURRENCY} | Duração: ${DURATION_SECONDS}s | Pool de wallets: ${WALLET_POOL_SIZE}`);
  console.log("Obtendo token do Keycloak...");
  const token = await fetchToken();

  console.log(`Criando ${WALLET_POOL_SIZE} wallets de setup (saldo ${WALLET_INITIAL_BALANCE} BRL cada)...`);
  const walletIds = await createWalletPool(token, WALLET_POOL_SIZE);
  const playerIdByWallet = new Map(walletIds.map((id) => [id, randomUUID()]));

  console.log("Iniciando carga...\n");
  const results: RequestResult[] = [];
  const deadline = Date.now() + DURATION_SECONDS * 1000;

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      const walletId = walletIds[Math.floor(Math.random() * walletIds.length)]!;
      const playerId = playerIdByWallet.get(walletId)!;
      results.push(await submitBet(token, walletId, playerId));
    }
  }

  const wallStart = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const wallElapsedSeconds = (performance.now() - wallStart) / 1000;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const processed = results.filter((r) => r.outcome === "processed").length;
  const rejected = results.filter((r) => r.outcome === "rejected").length;
  const errors = results.filter((r) => r.outcome === "error").length;

  console.log("=== Resultado ===");
  console.log(`Total de requisições: ${results.length}`);
  console.log(`Throughput: ${(results.length / wallElapsedSeconds).toFixed(1)} req/s`);
  console.log(`Processadas (201): ${processed} (${((processed / results.length) * 100).toFixed(1)}%)`);
  console.log(`Rejeitadas por regra de negócio (422): ${rejected} (${((rejected / results.length) * 100).toFixed(1)}%)`);
  console.log(`Erros (transporte/5xx): ${errors} (${((errors / results.length) * 100).toFixed(2)}%)`);
  console.log(`Latência p50: ${percentile(latencies, 50).toFixed(1)}ms`);
  console.log(`Latência p95: ${percentile(latencies, 95).toFixed(1)}ms`);
  console.log(`Latência p99: ${percentile(latencies, 99).toFixed(1)}ms`);
  console.log(`Latência máxima: ${Math.max(...latencies).toFixed(1)}ms`);
  console.log(
    "\nNota: outbox lag e conflitos de lock não são medidos aqui — exigiriam um endpoint de diagnóstico" +
      " que este serviço não expõe (ver ARCHITECTURE.md, seção de teste de carga).",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
