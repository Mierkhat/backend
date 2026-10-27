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
  readContract,
  unhex,
  validateBundle,
  type DeploymentBundle,
} from "../src/index.js";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const privateDir = resolve(root, ".tooling/testnet/position-routes");
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const evidencePath = resolve(
  root,
  "contracts/evidence/testnet-position-routes.json",
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
const addr = (address: string) => Address.fromString(address).toScVal();
const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
const tokenA = base.profile.assets[0]!.asset,
  tokenB = base.profile.assets[1]!.asset;
async function balance(token: string) {
  return BigInt(
    scValToNative(
      await readContract(server, base, owner.publicKey(), token, "balance", [
        addr(owner.publicKey()),
      ]),
    ),
  );
}
const amount = (await balance(tokenA)) / 1000n;
assert(amount > 1000n, "InsufficientActualTestnetLiquidity");
await submit(
  "liquidity_mka_mkb",
  new Contract(base.profile.router.address).call(
    "add_liquidity",
    addr(tokenA),
    addr(tokenB),
    i128(amount),
    i128((await balance(tokenB)) / 1000n),
    i128(1n),
    i128(1n),
    addr(owner.publicKey()),
    nativeToScVal(BigInt((await latestLedger(server)).timestamp) + 300n, {
      type: "u64",
    }),
  ),
);
const config = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({
    key: nativeToScVal("address", { type: "symbol" }),
    val: addr(base.profile.settlement),
  }),
  new xdr.ScMapEntry({
    key: nativeToScVal("strategies", { type: "symbol" }),
    val: xdr.ScVal.scvVec([]),
  }),
]);
const roles = xdr.ScVal.scvMap(
  [0, 1, 2, 3].map(
    (n) =>
      new xdr.ScMapEntry({
        key: nativeToScVal(n, { type: "u32" }),
        val: addr(admin.publicKey()),
      }),
  ),
);
const metadata = xdr.ScVal.scvMap(
  [
    ["name", "Mierkhat MKOUT vault"],
    ["symbol", "MOV"],
  ].map(
    ([key, value]) =>
      new xdr.ScMapEntry({
        key: nativeToScVal(key!, { type: "string" }),
        val: nativeToScVal(value!, { type: "string" }),
      }),
  ),
);
const vaultValue = await submit(
  "deploy_mkout_vault",
  Operation.createCustomContract({
    address: Address.fromString(owner.publicKey()),
    wasmHash: unhex(base.profile.vault.wasm_hash),
    salt: randomBytes(32),
    constructorArgs: [
      xdr.ScVal.scvVec([config]),
      roles,
      nativeToScVal(0, { type: "u32" }),
      addr(admin.publicKey()),
      nativeToScVal(0, { type: "u32" }),
      addr(base.profile.router.address),
      metadata,
      nativeToScVal(false),
    ],
  }),
);
assert(vaultValue, "MissingVaultAddress");
const vault = String(scValToNative(vaultValue));
const seed = (await balance(base.profile.settlement)) / 10000n;
assert(seed > 1000n, "InsufficientActualDeposit");
await submit(
  "seed_mkout_vault",
  new Contract(vault).call(
    "deposit",
    xdr.ScVal.scvVec([i128(seed)]),
    xdr.ScVal.scvVec([i128(1n)]),
    addr(owner.publicKey()),
    nativeToScVal(false),
  ),
);
const additions: DeploymentBundle[] = [];
for (const holding of [
  {
    vault: base.profile.vault,
    assets: base.profile.assets.map((a) => a.asset),
    name: base.vaultName,
    key: "dual",
  },
  {
    vault: { address: vault, wasm_hash: base.profile.vault.wasm_hash },
    assets: [base.profile.settlement],
    name: "Mierkhat MKOUT vault",
    key: "mkout",
  },
])
  for (const output of base.tokens) {
    if (holding.key === "dual" && output.address === base.profile.settlement)
      continue;
    const assets: DeploymentBundle["profile"]["assets"] = [];
    for (const asset of holding.assets) {
      const pair =
        asset === output.address
          ? null
          : {
              address: String(
                scValToNative(
                  await readContract(
                    server,
                    base,
                    owner.publicKey(),
                    base.profile.router.address,
                    "router_pair_for",
                    [addr(asset), addr(output.address)],
                  ),
                ),
              ),
              wasm_hash: base.profile.assets[0]!.pair!.wasm_hash,
            };
      assets.push({ asset, pair });
    }
    const profile: DeploymentBundle["profile"] = {
      ...base.profile,
      vault: holding.vault,
      settlement: output.address,
      assets,
    };
    const label = "guard_" + holding.key + "_" + output.symbol.toLowerCase();
    const value = await submit(
      label,
      Operation.createCustomContract({
        address: Address.fromString(owner.publicKey()),
        wasmHash: unhex(base.guardWasmHash),
        salt: randomBytes(32),
        constructorArgs: [profileScVal(profile)],
      }),
    );
    assert(value, "MissingGuardAddress");
    const needed = new Set([...holding.assets, output.address]);
    const bundle = validateBundle({
      ...base,
      epoch:
        "positions-" + holding.key + "-" + output.symbol.toLowerCase() + "-v1",
      guard: String(scValToNative(value)),
      profile,
      profileHash: profileHash(profile),
      vaultName: holding.name,
      tokens: base.tokens.filter((t) => needed.has(t.address)),
    });
    await loadDeployment(bundle, server, owner.publicKey());
    additions.push(bundle);
    state.bundles = additions;
    await save();
  }
const all = [
  ...registry.filter((b) => !additions.some((a) => a.epoch === b.epoch)),
  ...additions,
];
assert(new Set(all.map((b) => b.epoch)).size === all.length, "DuplicateEpoch");
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
  new Set(all.map((b) => b.profile.vault.address)).size,
  "real vaults and",
  all.length,
  "pinned testnet output routes; original deployment retained",
);
