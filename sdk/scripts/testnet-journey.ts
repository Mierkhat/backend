/** Real public-testnet acceptance. No RPC interception, fabricated balances or wallet signatures. */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, Transaction, rpc } from "@stellar/stellar-sdk";
import {
  assert,
  bundleSchema,
  verifySetup,
  verifySetupSigned,
  signSetup,
  latestLedger,
  reviewLedger,
  createExitDraft,
  quoteExit,
  ExitController,
  loadDeployment,
  decodeReceipt,
  accountState,
} from "../src/index.js";
import type {
  SetupDraft,
  SetupReview,
  Review,
  Observation,
  WalletAdapter,
} from "../src/index.js";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url))),
  privateDir = resolve(root, ".tooling/testnet");
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const keyFile = resolve(privateDir, "journey-key.json");
let secret: string;
try {
  secret = JSON.parse(await readFile(keyFile, "utf8")).secret;
} catch {
  secret = Keypair.random().secret();
  await writeFile(keyFile, JSON.stringify({ secret }), { mode: 0o600 });
}
const key = Keypair.fromSecret(secret),
  owner = key.publicKey(),
  b = bundleSchema.parse(
    JSON.parse(
      await readFile(
        resolve(root, "backend/sdk/deployments/index.json"),
        "utf8",
      ),
    )[0],
  );
const server = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 12000,
});
const wallet: WalletAdapter = {
  identity: async () => ({
    address: owner,
    networkPassphrase: b.networkPassphrase,
  }),
  sign: async (bytes) => {
    const tx = new Transaction(bytes, b.networkPassphrase);
    tx.sign(key);
    return tx.toXDR();
  },
};
const path = resolve(root, "contracts/evidence/testnet-journey.json");
let evidence: any;
try {
  evidence = JSON.parse(await readFile(path, "utf8"));
} catch {
  evidence = {
    network: b.networkPassphrase,
    owner,
    startedAt: new Date().toISOString(),
    operations: {},
  };
}
assert(evidence.owner === owner, "JourneyKey");
async function save() {
  await writeFile(path + ".tmp", JSON.stringify(evidence, null, 2) + "\n");
  await rename(path + ".tmp", path);
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch("http://127.0.0.1:3001/v1" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(path === "/exit/submit"
        ? { "Idempotency-Key": (body as any).claimedHash }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  assert(r.ok, JSON.stringify(data));
  return data as T;
}
async function wait(hash: string, kind = "setup"): Promise<Observation> {
  for (let n = 0; n < 60; n++) {
    const o = await api<Observation>(
      kind === "exit"
        ? `/transactions/${hash}?environment=testnet`
        : `/setup/transactions/${hash}`,
    );
    if (o.state === "failed") throw Error("Confirmed failure " + hash);
    if (o.state === "succeeded") return o;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Unknown outcome " + hash + "; rerun to recover by exact hash");
}
async function setup(label: string, draft: SetupDraft) {
  if (evidence.operations[label]) return wait(evidence.operations[label].hash);
  const review = await api<SetupReview>("/setup/prepare", draft);
  verifySetup(review, draft, b, await reviewLedger(server, owner));
  const bytes = await signSetup(review, b, server, wallet),
    { hash } = verifySetupSigned(bytes, review, b);
  await writeFile(resolve(privateDir, "journey-" + label + ".xdr"), bytes, {
    mode: 0o600,
  });
  evidence.operations[label] = { hash };
  await save();
  const response = await api<{ hash: string }>("/setup/submit", {
    signedXdr: bytes,
    review,
  });
  assert(response.hash === hash, "SubmitHash");
  const observation = await wait(hash);
  evidence.operations[label] = observation;
  await save();
  console.log(label, hash);
  return observation;
}
await api("/testnet/fund", { owner });
let account = await accountState(b, server, owner);
assert(account.funded, "Funded");
evidence.funded = true;
await save();
if (!account.tokens.every((t) => t.trusted))
  await setup("trustlines", {
    kind: "trustlines",
    owner,
    amountsRaw: [],
    minimumsRaw: [],
    trustAssets: account.tokens.filter((t) => !t.trusted).map((t) => t.address),
  });
if (!evidence.operations.faucet) {
  const grant = await api<{ hash: string }>("/testnet/faucet", { owner });
  evidence.operations.faucet = { hash: grant.hash };
  await save();
}
evidence.operations.faucet = await wait(evidence.operations.faucet.hash);
await save();
await setup("deposit", {
  kind: "deposit",
  owner,
  amountsRaw: ["250000000", "250000000"],
  minimumsRaw: ["248750000", "248750000"],
  trustAssets: [],
});
if (!evidence.operations.exit) {
  account = await accountState(b, server, owner);
  evidence.beforeExit = account;
  await save();
  const shares = account.sharesRaw!;
  const q = await quoteExit(b, server, owner, shares),
    l = await latestLedger(server);
  const floor = (v: string) => ((BigInt(v) * 9950n) / 10000n).toString();
  const draft = createExitDraft({
    environment: "testnet",
    epoch: b.epoch,
    intent: {
      schema: 1,
      network_id: b.profile.network_id,
      guard: b.guard,
      profile_hash: b.profileHash,
      owner,
      recipient: owner,
      shares,
      min_withdraw: q.withdrawnRaw.map(floor),
      min_swap: q.swappedRaw.map(floor),
      min_receive: floor(q.receiveRaw),
      valid_before_time: (BigInt(l.timestamp) + 180n).toString(),
      valid_before_ledger: l.sequence + 36,
    },
  });
  const controller = new ExitController();
  controller.setDraft(draft);
  const review = await controller.prepare((d) =>
    api<Review>("/exit/prepare", { ...d }),
  );
  assert(review, "Review");
  const a = await controller.signExit(
    review,
    b,
    wallet,
    () => reviewLedger(server, owner),
    () => loadDeployment(b, server, owner),
  );
  assert(a, "Signed");
  await writeFile(resolve(privateDir, "journey-exit.xdr"), a.signedXdr, {
    mode: 0o600,
  });
  evidence.operations.exit = { hash: a.txHash };
  await save();
  await api("/exit/submit", {
    environment: "testnet",
    epoch: b.epoch,
    signedXdr: a.signedXdr,
    claimedHash: a.txHash,
    reviewId: review.reviewId,
  });
}
evidence.operations.exit = await wait(evidence.operations.exit.hash, "exit");
assert(evidence.operations.exit.receipt, "VerifiedReceipt");
evidence.afterExit = await accountState(b, server, owner);
assert(evidence.afterExit.sharesRaw === "0", "ShareSpend");
for (const asset of b.profile.assets) {
  const before = evidence.beforeExit.tokens.find(
      (t: any) => t.address === asset.asset,
    ),
    after = evidence.afterExit.tokens.find(
      (t: any) => t.address === asset.asset,
    );
  assert(before.balanceRaw === after.balanceRaw, "ExistingUnderlyingChanged");
}
const settlementBefore = BigInt(
    evidence.beforeExit.tokens.find(
      (t: any) => t.address === b.profile.settlement,
    ).balanceRaw,
  ),
  settlementAfter = BigInt(
    evidence.afterExit.tokens.find(
      (t: any) => t.address === b.profile.settlement,
    ).balanceRaw,
  );
assert(
  settlementAfter - settlementBefore ===
    BigInt(evidence.operations.exit.receipt.received),
  "ReceiptDelta",
);
evidence.completedAt = new Date().toISOString();
evidence.assertions = {
  realTestnet: true,
  allTransactionsConfirmed: true,
  entireShareBalanceSpent: true,
  existingUnderlyingBalancesUnchanged: true,
  settlementDeltaMatchesReceipt: true,
};
await save();
console.log(
  "PASS real testnet funding, trustlines, issuance, deposit, guarded exit, receipt and balance invariants",
  JSON.stringify(evidence.operations),
);
