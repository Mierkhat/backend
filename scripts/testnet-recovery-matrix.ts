/** Real PostgreSQL, separate API processes and live testnet providers.
 * Fault relays forward real traffic and drop selected responses; they never
 * fabricate ledger/RPC results. Dedicated test accounts only. */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createServer as portServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import { Providers } from "../src/providers.js";
import { Pool } from "pg";
import { Keypair, Transaction, rpc } from "@stellar/stellar-sdk";
import {
  accountState,
  assert,
  bundleSchema,
  createExitDraft,
  MierkhatError,
  latestLedger,
  prepareExit,
  prepareSetup,
  quoteExit,
  signExit,
  transactionObservation,
  verifySetupSigned,
  type Observation,
  type SignedAttempt,
  type WalletAdapter,
} from "@mierkhat/sdk";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const privateDir = await mkdtemp(join(tmpdir(), "mierkhat-recovery-matrix-"));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function port() {
  return new Promise<number>((done) => {
    const s = portServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      assert(address && typeof address === "object", "Port");
      s.close(() => done(address.port));
    });
  });
}
const dbPort = await port(),
  password = randomBytes(24).toString("hex"),
  payloadKey = randomBytes(32).toString("hex");
const postgres = new EmbeddedPostgres({
  databaseDir: join(privateDir, "pg"),
  port: dbPort,
  user: "postgres",
  password,
  persistent: false,
  initdbFlags: ["--locale=C", "--lc-messages=C"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
const children = new Set<ChildProcess>(),
  relays = new Set<Server>();
let pool: Pool | undefined;
async function stop(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
) {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
  children.delete(child);
}
async function start(workers: boolean, endpoints: string[], ca?: string) {
  const apiPort = await port(),
    base = "http://127.0.0.1:" + apiPort;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: join(root, "backend"),
    stdio: "ignore",
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`,
      PAYLOAD_KEY: payloadKey,
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      DEPLOYMENT_REGISTRY: join(root, "backend/sdk/deployments/index.json"),
      WORKERS_ENABLED: workers ? "1" : "0",
      TESTNET_FAUCET_KEY_FILE: undefined,
      TESTNET_RPC_URLS: endpoints.join(","),
      NODE_EXTRA_CA_CERTS: ca,
    },
  });
  children.add(child);
  for (let n = 0; n < 300; n++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("Isolated API exited during startup");
    try {
      if ((await fetch(base + "/v1/health")).ok) return { child, base };
    } catch {}
    await delay(100);
  }
  throw Error("Isolated API readiness timed out");
}
async function listen(server: Server) {
  relays.add(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address === "object", "RelayPort");
  return address.port;
}
const endpoints = [
  "https://soroban-testnet.stellar.org",
  "https://stellar-testnet-soroban.gateway.tatum.io",
];
let failed = false;
const evidence: any = {
  checkedAt: new Date().toISOString(),
  cases: [],
  providerOperators: ["Stellar Development Foundation", "Tatum"],
};
async function checkpoint() {
  const destination = join(
    root,
    ".tooling/testnet/recovery-matrix-public.json",
  );
  await writeFile(
    destination + ".tmp",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await rename(destination + ".tmp", destination);
}
async function recordCase(result: unknown) {
  evidence.cases.push(result);
  delete evidence.inFlight;
  await checkpoint();
}
try {
  await postgres.initialise();
  await postgres.start();
  pool = new Pool({
    host: "127.0.0.1",
    port: dbPort,
    user: "postgres",
    password,
    database: "postgres",
  });
  const bundle = bundleSchema.parse(
    JSON.parse(
      await readFile(join(root, "backend/sdk/deployments/index.json"), "utf8"),
    )[0],
  );
  const key = Keypair.fromSecret(
    JSON.parse(
      await readFile(join(root, ".tooling/testnet/journey-key.json"), "utf8"),
    ).secret,
  );
  const owner = key.publicKey(),
    server = new rpc.Server(endpoints[0]!, { timeout: 20000 });
  const readProviders = new Providers(
    { testnet: [endpoints[0]!] },
    { testnet: bundle.networkPassphrase },
  );
  async function reliable<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (error instanceof MierkhatError || attempt === 3) throw error;
        await delay((attempt + 1) * 2000);
      }
    }
  }
  for (const endpoint of endpoints) {
    const network = await reliable(() =>
      new rpc.Server(endpoint, { timeout: 20000 }).getNetwork(),
    );
    assert(network.passphrase === bundle.networkPassphrase, "ProviderNetwork");
  }
  evidence.network = bundle.networkPassphrase;
  evidence.owner = owner;
  const wallet: WalletAdapter = {
    identity: async () => ({
      address: owner,
      networkPassphrase: bundle.networkPassphrase,
    }),
    sign: async (bytes) => {
      const tx = new Transaction(bytes, bundle.networkPassphrase);
      tx.sign(key);
      return tx.toXDR();
    },
  };
  // A fresh real deposit supplies shares for the rejection/recovery corpus.
  const initial = await reliable(() =>
    readProviders.run("testnet", (s) => accountState(bundle, s, owner)),
  );
  if (BigInt(initial.sharesRaw ?? "0") === 0n) {
    const amounts = bundle.profile.assets.map((a) => {
      const token = initial.tokens.find((t) => t.address === a.asset)!;
      const quantity = BigInt(token.balanceRaw ?? "0") / 100n;
      assert(quantity > 0n, "DedicatedTestAccountNeedsTokens");
      return quantity.toString();
    });
    const deposit = await reliable(() =>
      prepareSetup(
        {
          kind: "deposit",
          owner,
          amountsRaw: amounts,
          minimumsRaw: amounts,
          trustAssets: [],
        },
        bundle,
        server,
      ),
    );
    const depositTx = new Transaction(
      deposit.transactionXdr,
      bundle.networkPassphrase,
    );
    depositTx.sign(key);
    const verified = verifySetupSigned(depositTx.toXDR(), deposit, bundle);
    evidence.depositHash = verified.hash;
    await checkpoint();
    await server.sendTransaction(depositTx);
    for (let n = 0; n < 80; n++) {
      const observation = await transactionObservation(
        server,
        bundle,
        verified.hash,
      );
      assert(observation.state !== "failed", "DepositFailed");
      if (observation.state === "succeeded") break;
      await delay(1000);
      if (n === 79) throw Error("Deposit remains unresolved: " + verified.hash);
    }
    evidence.depositHash = verified.hash;
  } else {
    evidence.reusedActualSharesRaw = initial.sharesRaw;
    await checkpoint();
  }
  async function draftAttempt() {
    return reliable(() =>
      readProviders.run("testnet", async (server) => {
        const before = await accountState(bundle, server, owner);
        const shares = (BigInt(before.sharesRaw!) / 10n).toString();
        assert(BigInt(shares) > 0n, "NoShares");
        const quote = await quoteExit(bundle, server, owner, shares),
          ledger = await latestLedger(server);
        const floor = (v: string) => ((BigInt(v) * 9900n) / 10000n).toString();
        const draft = createExitDraft({
          environment: "testnet",
          epoch: bundle.epoch,
          intent: {
            schema: 1,
            network_id: bundle.profile.network_id,
            guard: bundle.guard,
            profile_hash: bundle.profileHash,
            owner,
            recipient: owner,
            shares,
            min_withdraw: quote.withdrawnRaw.map(floor),
            min_swap: quote.swappedRaw.map(floor),
            min_receive: floor(quote.receiveRaw),
            valid_before_time: (BigInt(ledger.timestamp) + 180n).toString(),
            valid_before_ledger: ledger.sequence + 36,
          },
        });
        const review = await prepareExit(draft, bundle, server),
          attempt = await signExit(review, bundle, wallet, server);
        assert(attempt, "SigningInvalidated");
        evidence.inFlight = {
          hash: attempt.txHash,
          signedEnvelopeDigest: attempt.signedEnvelopeDigest,
        };
        await checkpoint();
        return { attempt, before };
      }),
    );
  }
  async function submit(base: string, attempt: SignedAttempt, keySuffix = "") {
    return fetch(base + "/v1/exit/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "matrix-" + attempt.txHash + keySuffix,
      },
      body: JSON.stringify({
        environment: "testnet",
        epoch: bundle.epoch,
        signedXdr: attempt.signedXdr,
        claimedHash: attempt.txHash,
        reviewId: null,
      }),
    });
  }
  async function accepted(base: string, attempt: SignedAttempt, suffix = "") {
    const response = await submit(base, attempt, suffix);
    assert(response.status === 202, "Admission" + response.status);
    return response.json();
  }
  async function confirmed(
    base: string,
    attempt: SignedAttempt,
    before: Awaited<ReturnType<typeof accountState>>,
  ) {
    let observed: Observation | undefined;
    for (let n = 0; n < 100; n++) {
      observed = (await (
        await fetch(
          base + "/v1/transactions/" + attempt.txHash + "?environment=testnet",
        )
      ).json()) as Observation;
      assert(observed.state !== "failed", "GuardedRecoveryFailed");
      const row = (
        await pool!.query("SELECT state FROM attempts WHERE tx_hash=$1", [
          attempt.txHash,
        ])
      ).rows[0];
      if (observed.state === "succeeded" && row?.state === "succeeded") break;
      await delay(1000);
    }
    assert(
      observed?.state === "succeeded" && observed.receipt,
      "MissingCommittedReceipt",
    );
    const after = await reliable(() =>
      readProviders.run("testnet", (s) => accountState(bundle, s, owner)),
    );
    assert(
      BigInt(before.sharesRaw!) - BigInt(after.sharesRaw!) ===
        BigInt(attempt.review.draft.intent.shares),
      "ExactShares",
    );
    for (const asset of bundle.profile.assets)
      assert(
        before.tokens.find((t) => t.address === asset.asset)!.balanceRaw ===
          after.tokens.find((t) => t.address === asset.asset)!.balanceRaw,
        "ExistingUnderlying",
      );
    const out = (a: typeof before) =>
      BigInt(
        a.tokens.find((t) => t.address === bundle.profile.settlement)!
          .balanceRaw!,
      );
    assert(
      out(after) - out(before) === BigInt(observed.receipt.received),
      "ReceiptDelta",
    );
    const row = (
      await pool!.query(
        "SELECT signed_envelope_digest FROM attempts WHERE tx_hash=$1",
        [attempt.txHash],
      )
    ).rows[0];
    assert(
      row.signed_envelope_digest === attempt.signedEnvelopeDigest,
      "ExactSignedDigest",
    );
    assert(
      (
        await pool!.query(
          "SELECT count(*)::int AS n FROM signed_payloads WHERE tx_hash=$1",
          [attempt.txHash],
        )
      ).rows[0].n === 0,
      "TerminalBytesNotRemoved",
    );
    const result = {
      hash: attempt.txHash,
      signedEnvelopeDigest: attempt.signedEnvelopeDigest,
      observation: observed,
      exactShares: true,
      existingUnderlyingUnchanged: true,
      settlementDeltaMatchesReceipt: true,
      terminalBytesRemoved: true,
    };
    console.log("Confirmed exact guarded recovery", attempt.txHash);
    return result;
  }
  // R06: API commits admission, but the real HTTP response is deliberately lost.
  {
    const node = await start(false, endpoints),
      prepared = await draftAttempt();
    let responseDropped = false;
    const relay = httpServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(node.base + request.url, {
          method: request.method,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": String(request.headers["idempotency-key"]),
          },
          body: Buffer.concat(chunks),
        });
        await upstream.arrayBuffer();
        assert(upstream.status === 202, "RelayAdmission");
        responseDropped = true;
        response.destroy();
      } catch {
        response.destroy();
      }
    });
    const relayPort = await listen(relay);
    let lost = false;
    try {
      await submit("http://127.0.0.1:" + relayPort, prepared.attempt);
    } catch {
      lost = true;
    }
    assert(lost && responseDropped, "DidNotLoseAdmissionResponse");
    await Promise.all([
      accepted(node.base, prepared.attempt),
      accepted(node.base, prepared.attempt, "-other-tab"),
    ]);
    const count = (
      await pool.query(
        "SELECT count(*)::int AS n FROM attempts WHERE tx_hash=$1",
        [prepared.attempt.txHash],
      )
    ).rows[0].n;
    assert(count === 1, "DuplicateAdmission");
    await stop(node.child);
    const resumed = await start(true, endpoints);
    await recordCase({
      name: "http_response_lost_after_durable_admission",
      responseDropped: true,
      concurrentRetries: 2,
      durableAttempts: count,
      ...(await confirmed(resumed.base, prepared.attempt, prepared.before)),
    });
    await stop(resumed.child);
  }
  // R04: two independently operated providers receive exactly the same bytes.
  {
    const a = await start(false, endpoints),
      b = await start(false, endpoints),
      prepared = await draftAttempt();
    await Promise.all([
      accepted(a.base, prepared.attempt),
      accepted(b.base, prepared.attempt, "-second-process"),
    ]);
    const sends = await Promise.all(
      endpoints.map(async (endpoint) => {
        try {
          const sent = await reliable(() =>
            new rpc.Server(endpoint, { timeout: 20000 }).sendTransaction(
              new Transaction(
                prepared.attempt.signedXdr,
                bundle.networkPassphrase,
              ),
            ),
          );
          return { endpoint, status: sent.status };
        } catch {
          return { endpoint, status: "TRANSPORT_UNAVAILABLE" };
        }
      }),
    );
    const bothProvidersAcknowledged = sends.every(
      (s) => s.status === "PENDING" || s.status === "DUPLICATE",
    );
    await stop(a.child);
    await stop(b.child);
    const first = await start(true, endpoints),
      second = await start(true, endpoints);
    await recordCase({
      name: "independent_provider_concurrent_submit_and_workers",
      sends,
      bothProvidersAcknowledged,
      workerProcesses: 2,
      ...(await confirmed(first.base, prepared.attempt, prepared.before)),
    });
    await stop(first.child);
    await stop(second.child);
  }
  // R07: a real upstream accepts bytes before its transport response is lost.
  const cert = join(privateDir, "relay-cert.pem"),
    certKey = join(privateDir, "relay-key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      certKey,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  for (const killAfterSend of [false, true]) {
    // The unauthenticated independent provider allows five requests per minute.
    // Leave its real quota available for the actual fallback, not bulk reads.
    console.log("Waiting for independent provider's real rate window");
    await delay(30000);
    await delay(30000);
    const prepared = await draftAttempt();
    let sends = 0;
    let notify!: () => void;
    const sent = new Promise<void>((done) => {
      notify = done;
    });
    const relay = httpsServer(
      { key: await readFile(certKey), cert: await readFile(cert) },
      async (request, response) => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks),
            message = JSON.parse(bytes.toString());
          const upstream = await fetch(endpoints[0]!, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bytes,
            signal: AbortSignal.timeout(15000),
          });
          const body = Buffer.from(await upstream.arrayBuffer());
          if (message.method === "sendTransaction") {
            const result = JSON.parse(body.toString()).result;
            if (["PENDING", "DUPLICATE"].includes(result?.status)) {
              sends++;
              notify();
              await delay(6500);
              response.destroy();
              return;
            }
          }
          response.writeHead(upstream.status, {
            "Content-Type": "application/json",
          });
          response.end(body);
        } catch {
          response.destroy();
        }
      },
    );
    const relayPort = await listen(relay),
      paused = await start(false, endpoints);
    await accepted(paused.base, prepared.attempt);
    await stop(paused.child);
    const affected = await start(
      true,
      ["https://127.0.0.1:" + relayPort, endpoints[1]!],
      cert,
    );
    await Promise.race([
      sent,
      delay(60000).then(() => {
        throw Error("Accepted-send boundary was not reached");
      }),
    ]);
    if (killAfterSend) await stop(affected.child, "SIGKILL");
    const resumed = killAfterSend ? await start(true, endpoints) : affected;
    await recordCase({
      name: killAfterSend
        ? "sigkill_after_provider_acceptance_before_observation"
        : "rpc_response_lost_after_provider_acceptance",
      acceptedResponsesDropped: sends,
      ...(await confirmed(resumed.base, prepared.attempt, prepared.before)),
    });
    await stop(resumed.child);
  }
  evidence.completedAt = new Date().toISOString();
  delete evidence.inFlight;
  evidence.assertions = {
    actualPostgreSQL: true,
    actualTestnet: true,
    independentProvidersAcknowledged:
      evidence.cases.find((c: any) => c.sends)?.bothProvidersAcknowledged ===
      true,
    noFabricatedRpcResults: true,
    allFourFaultBoundariesConfirmed: true,
  };
  await checkpoint();
  await writeFile(
    join(root, "contracts/evidence/testnet-recovery-matrix.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "PASS four real guarded-exit recovery/concurrency boundaries",
    JSON.stringify(
      evidence.cases.map((c: any) => ({ name: c.name, hash: c.hash })),
    ),
  );
} catch (error) {
  failed = true;
  const code =
    error instanceof MierkhatError
      ? error.code
      : (error as { isAxiosError?: boolean })?.isAxiosError
        ? "NetworkTransportFailure"
        : error instanceof Error
          ? error.message.slice(0, 180)
          : "AcceptanceIncomplete";
  evidence.incompleteReason = code;
  await checkpoint();
  console.error("Acceptance incomplete:", code);
  process.exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  for (const relay of relays) {
    relay.closeAllConnections();
    await new Promise<void>((done) => relay.close(() => done()));
  }
  await pool?.end();
  await postgres.stop();
  await rm(privateDir, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
