/** Black box process-kill acceptance with actual Postgres and signed Stellar testnet bytes. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { Keypair, Transaction, rpc } from "@stellar/stellar-sdk";
import {
  bundleSchema,
  prepareSetup,
  verifySetupSigned,
  type Observation,
} from "@mierkhat/sdk";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url))),
  dir = await mkdtemp(join(tmpdir(), "mierkhat-crash-")),
  password = randomBytes(24).toString("hex"),
  key = randomBytes(32).toString("hex");
async function port() {
  return new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") throw Error("Port");
      s.close(() => r(a.port));
    });
  });
}
const dbPort = await port(),
  httpPort = await port(),
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    port: dbPort,
    user: "postgres",
    password,
    persistent: false,
    initdbFlags: ["--locale=C", "--lc-messages=C"],
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => {},
    onError: () => {},
  }),
  base = "http://127.0.0.1:" + httpPort;
let child: ChildProcess | undefined, pool: Pool | undefined;
try {
  await pg.initialise();
  await pg.start();
  pool = new Pool({
    host: "127.0.0.1",
    port: dbPort,
    user: "postgres",
    password,
    database: "postgres",
  });
  const b = bundleSchema.parse(
      JSON.parse(
        await readFile(
          resolve(root, "backend/sdk/deployments/index.json"),
          "utf8",
        ),
      )[0],
    ),
    secrets = JSON.parse(
      await readFile(
        resolve(root, ".tooling/testnet/journey-key.json"),
        "utf8",
      ),
    ),
    signer = Keypair.fromSecret(secrets.secret),
    server = new rpc.Server("https://soroban-testnet.stellar.org", {
      timeout: 12000,
    });
  const review = await prepareSetup(
      {
        kind: "trustlines",
        owner: signer.publicKey(),
        amountsRaw: [],
        minimumsRaw: [],
        trustAssets: b.tokens.map((t) => t.address),
      },
      b,
      server,
    ),
    tx = new Transaction(review.transactionXdr, b.networkPassphrase);
  tx.sign(signer);
  const bytes = tx.toXDR(),
    verified = verifySetupSigned(bytes, review, b);
  async function start(paused: boolean) {
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: resolve(root, "backend"),
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`,
        PAYLOAD_KEY: key,
        PORT: String(httpPort),
        WORKERS_ENABLED: paused ? "0" : "1",
        TESTNET_FAUCET_KEY_FILE: undefined,
      },
    });
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(base + "/v1/health")).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Child API did not become ready");
  }
  await start(true);
  const response = await fetch(base + "/v1/setup/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedXdr: bytes, review }),
  });
  if (response.status !== 202)
    throw Error("Record rejected " + (await response.text()));
  const before = (
    await pool.query(
      "SELECT state,signed_digest,encrypted FROM setup_jobs WHERE tx_hash=$1",
      [verified.hash],
    )
  ).rows[0];
  if (before.state !== "recorded" || !before.encrypted)
    throw Error("Missing durable pre-send bytes");
  const killed = child!;
  await new Promise<void>((resolve) => {
    killed.once("exit", () => resolve());
    killed.kill("SIGKILL");
  });
  child = undefined;
  const absent = await server.getTransaction(verified.hash);
  if (absent.status !== "NOT_FOUND")
    throw Error("Worker sent before kill boundary");
  await start(false);
  let observation: Observation | undefined;
  for (let n = 0; n < 80; n++) {
    const r = await fetch(base + "/v1/setup/transactions/" + verified.hash);
    observation = (await r.json()) as Observation;
    if (observation.state === "failed") throw Error("Recovery failed on chain");
    if (observation.state === "succeeded") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (observation?.state !== "succeeded")
    throw Error("Unresolved recovery " + verified.hash);
  const final = (
    await pool.query(
      "SELECT state,signed_digest,encrypted FROM setup_jobs WHERE tx_hash=$1",
      [verified.hash],
    )
  ).rows[0];
  if (final.signed_digest !== before.signed_digest)
    throw Error("Signed bytes changed");
  const evidence = {
    checkedAt: new Date().toISOString(),
    network: b.networkPassphrase,
    owner: signer.publicKey(),
    hash: verified.hash,
    observation,
    signedEnvelopeDigest: verified.digest,
    assertions: {
      actualPostgreSQL: true,
      actualTestnet: true,
      httpAcceptedAfterCommit: true,
      killedWithSigkillBeforeSend: true,
      rpcNotFoundBeforeRestart: true,
      restartRecoveredSameHash: true,
      unchangedSignedDigest: true,
    },
  };
  await writeFile(
    resolve(root, "contracts/evidence/testnet-crash-recovery.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "PASS actual SIGKILL/restart before send, exact signed-byte recovery and committed testnet result",
    verified.hash,
  );
} finally {
  if (child) {
    const p = child;
    await new Promise<void>((r) => {
      p.once("exit", () => r());
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 5000).unref();
    });
  }
  await pool?.end();
  await pg.stop();
  await rm(dir, { recursive: true, force: true });
}
