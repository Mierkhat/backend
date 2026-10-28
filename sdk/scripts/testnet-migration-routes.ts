/** Extend the real testnet deployment with a second vault and pinned output routes.
 * Public checkpoints contain hashes and addresses; signed bytes remain private. */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  assert,
  bundleSchema,
  digest,
  hex,
  latestLedger,
  loadDeployment,
  profileHash,
  profileScVal,
  bundleProfileHash,
  bundleProfileScVal,
  readContract,
  unhex,
  validateBundle,
  type DeploymentBundle,
} from "../src/index.js";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const privateDir = resolve(root, ".tooling/testnet/migration-routes");
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const evidencePath = resolve(
  root,
  "contracts/evidence/testnet-migration-routes.json",
);
const registryPath = resolve(root, "backend/sdk/deployments/index.json");
const registry = (
  JSON.parse(await readFile(registryPath, "utf8")) as unknown[]
).map((b) => bundleSchema.parse(b));
const base = registry[0]!;
assert(
  base.environment === "testnet" && base.networkPassphrase === Networks.TESTNET,
  "TestnetOnly",
);
const keys = JSON.parse(
  await readFile(resolve(root, ".tooling/testnet/keys.json"), "utf8"),
);
const owner = Keypair.fromSecret(keys.owner),
  admin = Keypair.fromSecret(keys.admin);
const server = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 20000,
});
assert(
  (await server.getNetwork()).passphrase === Networks.TESTNET,
  "WrongNetwork",
);
type Checkpoint = {
  operations: Record<
    string,
    { hash: string; ledger?: number; returnValue?: string }
  >;
  bundles?: DeploymentBundle[];
  verifiedAt?: string;
};
let state: Checkpoint;
try {
  state = JSON.parse(await readFile(evidencePath, "utf8"));
} catch {
  state = { operations: {} };
}
async function save() {
  await writeFile(evidencePath + ".tmp", JSON.stringify(state, null, 2) + "\n");
  await rename(evidencePath + ".tmp", evidencePath);
}
async function submit(
  label: string,
  operation: xdr.Operation,
): Promise<xdr.ScVal | undefined> {
  let prior = state.operations[label];
  if (prior?.ledger)
    return prior.returnValue
      ? xdr.ScVal.fromXDR(prior.returnValue, "base64")
      : undefined;
  let bytes: string;
  if (prior)
    bytes = await readFile(resolve(privateDir, label + ".xdr"), "utf8");
  else {
    const raw = new TransactionBuilder(
      await server.getAccount(owner.publicKey()),
      { fee: "10000", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(operation)
      .setTimeout(180)
      .build();
    const simulation = await server.simulateTransaction(raw);
    assert(
      rpc.Api.isSimulationSuccess(simulation) &&
        !rpc.Api.isSimulationRestore(simulation),
      "PreparationRejected:" + label,
    );
    const tx = rpc.assembleTransaction(raw, simulation).build();
    tx.sign(owner);
    bytes = tx.toXDR();
    prior = { hash: hex(tx.hash()) };
    await writeFile(resolve(privateDir, label + ".xdr"), bytes, {
      mode: 0o600,
    });
    state.operations[label] = prior;
    await save();
  }
  // Recover identical bytes; never replace an uncertain transaction with a new one.
  for (let attempt = 0; attempt < 45; attempt++) {
    const result = await server.getTransaction(prior.hash);
    if (result.status !== "NOT_FOUND") {
      assert(result.status === "SUCCESS", "CommittedFailure:" + label);
      state.operations[label] = {
        hash: prior.hash,
        ledger: result.ledger,
        returnValue: result.returnValue?.toXDR("base64"),
      };
      await save();
      console.log(label, prior.hash);
      return result.returnValue;
    }
    if (attempt === 0) {
      const tx = new Transaction(bytes, Networks.TESTNET);
      assert(hex(tx.hash()) === prior.hash, "RecoveryHashMismatch");
      await server.sendTransaction(tx);
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw Error(
    "Unresolved " +
      label +
      ": " +
      prior.hash +
      "; rerun to reconcile identical bytes",
  );
}

const wasm = await readFile(
  resolve(
    root,
    "contracts/target/wasm32v1-none/release/mierkhat_migration.wasm",
  ),
);
const wasmHash = digest(wasm);
await submit("upload_migration", Operation.uploadContractWasm({ wasm }));
const dual = registry.find(
  (b) =>
    !b.migration &&
    b.profile.assets.length === 2 &&
    b.profile.settlement === base.profile.settlement,
)!;
const single = registry.find(
  (b) =>
    !b.migration &&
    b.profile.assets.length === 1 &&
    b.profile.assets[0]!.asset === b.profile.settlement,
)!;
assert(dual && single, "MigrationSourcesMissing");
const additions: DeploymentBundle[] = [];
for (const [source, destination, label] of [
  [dual, single, "dual_to_mkout"],
  [single, dual, "mkout_to_dual"],
] as const) {
  const destination_assets = destination.profile.assets.map((a) => ({
    asset: a.asset,
    pair:
      a.asset === source.profile.settlement
        ? null
        : dual.profile.assets.find((x) => x.asset === a.asset)!.pair,
  }));
  const candidate: DeploymentBundle = {
    ...source,
    epoch: "migration-" + label.replaceAll("_", "-") + "-v1",
    guardWasmHash: wasmHash,
    tokens: base.tokens,
    migration: {
      destination: destination.profile.vault,
      destination_assets,
      destinationName: destination.vaultName,
      destinationShareDecimals: destination.shareDecimals,
    },
  };
  candidate.profileHash = bundleProfileHash(candidate);
  const value = await submit(
    "migration_" + label,
    Operation.createCustomContract({
      address: Address.fromString(owner.publicKey()),
      wasmHash: unhex(wasmHash),
      salt: randomBytes(32),
      constructorArgs: [bundleProfileScVal(candidate)],
    }),
  );
  assert(value, "MissingMigrationAddress");
  candidate.guard = String(scValToNative(value));
  const b = validateBundle(candidate);
  await loadDeployment(b, server, owner.publicKey());
  additions.push(b);
  state.bundles = additions;
  await save();
}
const all = [
  ...registry.filter((b) => !additions.some((a) => a.epoch === b.epoch)),
  ...additions,
];
state.verifiedAt = new Date().toISOString();
await save();
for (const path of [
  registryPath,
  resolve(root, "frontend/src/deployments.json"),
]) {
  await writeFile(path + ".tmp", JSON.stringify(all, null, 2) + "\n");
  await rename(path + ".tmp", path);
}
console.log(
  "PASS",
  additions.length,
  "real cross-asset migration profiles",
  wasmHash,
);
