import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { bundleSchema } from "@mierkhat/sdk";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { Providers } from "./providers.js";
import { Keypair } from "@stellar/stellar-sdk";
import { SetupService } from "./setup.js";
import { reconcileOne } from "./worker.js";
const databaseUrl = process.env.DATABASE_URL;
const payloadKey = process.env.PAYLOAD_KEY;
if (!databaseUrl || !payloadKey || !/^[0-9a-f]{64}$/.test(payloadKey))
  throw Error(
    "Set DATABASE_URL and PAYLOAD_KEY (32 byte hex) in the server environment",
  );
const bundles = (
  JSON.parse(
    await readFile(
      process.env.DEPLOYMENT_REGISTRY ??
        new URL("../sdk/deployments/index.json", import.meta.url),
      "utf8",
    ),
  ) as unknown[]
).map((v) => bundleSchema.parse(v));
const endpoints: Record<string, string[]> = {
  testnet: (
    process.env.TESTNET_RPC_URLS ?? "https://soroban-testnet.stellar.org"
  ).split(","),
  local: (
    process.env.LOCAL_RPC_URLS ?? "http://127.0.0.1:8000/soroban/rpc"
  ).split(","),
};
const networks = Object.fromEntries(
  bundles.map((b) => [b.environment, b.networkPassphrase]),
);
const pool = new Pool({
  connectionString: databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const store = new Store(pool, Buffer.from(payloadKey, "hex"));
await store.migrate();
const providers = new Providers(endpoints, networks);
let issuer: Keypair | undefined;
if (process.env.TESTNET_FAUCET_KEY_FILE) {
  const keys = JSON.parse(
    await readFile(process.env.TESTNET_FAUCET_KEY_FILE, "utf8"),
  );
  issuer = Keypair.fromSecret(keys.admin);
}
const liveBundle = bundles.find(
  (b) => b.environment === "testnet" && b.enabled,
);
const setup = liveBundle
  ? new SetupService(
      store,
      providers,
      bundles.filter((b) => b.environment === "testnet" && b.enabled),
      issuer,
    )
  : undefined;
const app = await createApp({
  setup,
  store,
  providers,
  bundles,
  origins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(","),
});
let stopping = false;
let active: Promise<unknown> | undefined;
const timer = setInterval(() => {
  if (stopping || active || process.env.WORKERS_ENABLED === "0") return;
  active = Promise.all([
    reconcileOne(store, providers, bundles),
    setup?.reconcile(),
  ])
    .catch(() => {})
    .finally(() => {
      active = undefined;
    });
}, 1000);
const prune = setInterval(() => {
  void store.prune().catch(() => {});
}, 60000);
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    stopping = true;
    clearInterval(timer);
    clearInterval(prune);
    await active;
    await app.close();
    await pool.end();
  });
