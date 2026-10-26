/** Dedicated public testnet integration harness. Keys and exact retry bytes stay ignored and mode 0600. */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Asset,
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
  digest,
  hex,
  intentScVal,
  nativeProfile,
  profileHash,
  unhex,
} from "../src/codec.js";
import { assert, txV1 } from "../src/policy.js";
import { prepareExit, decodeReceipt, latestLedger } from "../src/rpc.js";
import type { DeploymentBundle, ExitDraft } from "../src/model.js";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const privateDir = resolve(root, ".tooling/testnet");
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const evidencePath = resolve(root, "contracts/evidence/testnet-fixture.json");
const server = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 20000,
});
const passphrase = Networks.TESTNET;
assert((await server.getNetwork()).passphrase === passphrase, "WrongTestnet");
let secrets: { owner: string; admin: string };
try {
  secrets = JSON.parse(
    await readFile(resolve(privateDir, "keys.json"), "utf8"),
  );
} catch {
  secrets = {
    owner: Keypair.random().secret(),
    admin: Keypair.random().secret(),
  };
  await writeFile(resolve(privateDir, "keys.json"), JSON.stringify(secrets), {
    mode: 0o600,
  });
}
const owner = Keypair.fromSecret(secrets.owner),
  admin = Keypair.fromSecret(secrets.admin);
let state: any;
try {
  state = JSON.parse(await readFile(evidencePath, "utf8"));
} catch {
  state = {
    network: passphrase,
    owner: owner.publicKey(),
    admin: admin.publicKey(),
    operations: {},
    artifacts: {},
  };
}
assert(
  state.owner === owner.publicKey() && state.admin === admin.publicKey(),
  "FixtureKeyMismatch",
);
async function save() {
  await writeFile(evidencePath + ".tmp", JSON.stringify(state, null, 2) + "\n");
  await rename(evidencePath + ".tmp", evidencePath);
}
for (const key of [owner, admin]) {
  try {
    await server.getAccount(key.publicKey());
  } catch {
    const result = await fetch(
      "https://friendbot.stellar.org/?addr=" + key.publicKey(),
    );
    assert(result.ok, "Friendbot");
  }
}
async function wait(hash: string, bytes?: string) {
  for (let n = 0; n < 30; n++) {
    const result = await server.getTransaction(hash);
    if (result.status !== "NOT_FOUND") return result;
    if (bytes && n === 0)
      await server.sendTransaction(new Transaction(bytes, passphrase));
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error(
    "Unresolved transaction " + hash + "; rerun to reconcile exact bytes",
  );
}
async function submit(
  label: string,
  ops: xdr.Operation[],
  key = owner,
  soroban = true,
): Promise<any> {
  if (state.operations[label]) {
    const record = state.operations[label];
    const bytes = await readFile(resolve(privateDir, label + ".xdr"), "utf8");
    const result = await wait(record.hash, bytes);
    assert(result.status === "SUCCESS", "PriorFixtureFailure");
    return result;
  }
  let tx = new TransactionBuilder(await server.getAccount(key.publicKey()), {
    fee: "10000",
    networkPassphrase: passphrase,
  })
    .addOperation(ops[0]!)
    .setTimeout(180);
  for (const op of ops.slice(1)) tx = tx.addOperation(op);
  let built = tx.build();
  if (soroban) {
    const sim = await server.simulateTransaction(built);
    if (!rpc.Api.isSimulationSuccess(sim) || rpc.Api.isSimulationRestore(sim))
      throw Error(
        "Fixture simulation rejected at " +
          label +
          ": " +
          ("error" in sim ? sim.error : "restore required"),
      );
    built = rpc.assembleTransaction(built, sim).build();
  }
  built.sign(key);
  const bytes = built.toXDR();
  const hash = hex(built.hash());
  await writeFile(resolve(privateDir, label + ".xdr"), bytes, { mode: 0o600 });
  state.operations[label] = { hash };
  await save();
  const result = await wait(hash, bytes);
  assert(result.status === "SUCCESS", "Fixture transaction failed: " + label);
  state.operations[label] = {
    hash,
    ledger: result.ledger,
    fee: result.resultXdr.feeCharged.toString(),
  };
  await save();
  console.log(label, hash);
  return result;
}
const addresses: Record<string, string> = {};
for (const name of [
  "soroswap_pair",
  "soroswap_factory",
  "soroswap_router",
  "defindex_vault",
  "mierkhat_guard",
]) {
  const path =
    name === "mierkhat_guard"
      ? resolve(
          root,
          "contracts/target/wasm32v1-none/release/" + name + ".wasm",
        )
      : resolve(root, "contracts/artifacts/" + name + ".wasm");
  const bytes = await readFile(path),
    hash = digest(bytes);
  if (state.artifacts[name])
    assert(state.artifacts[name] === hash, "ArtifactChangedDuringFixture");
  state.artifacts[name] = hash;
  await save();
  await submit("upload_" + name, [
    Operation.uploadContractWasm({ wasm: bytes }),
  ]);
}
async function deploy(name: string, args: xdr.ScVal[] = []) {
  const label = "deploy_" + name;
  const result = await submit(label, [
    Operation.createCustomContract({
      address: Address.fromString(owner.publicKey()),
      wasmHash: unhex(state.artifacts[name]),
      salt: randomBytes(32),
      constructorArgs: args,
    }),
  ]);
  assert(result.returnValue, "MissingDeploymentResult");
  const address = String(scValToNative(result.returnValue));
  addresses[name] = address;
  return address;
}
const factory = await deploy("soroswap_factory");
await submit("initialize_factory", [
  new Contract(factory).call(
    "initialize",
    Address.fromString(admin.publicKey()).toScVal(),
    nativeToScVal(unhex(state.artifacts.soroswap_pair), { type: "bytes" }),
  ),
]);
const router = await deploy("soroswap_router");
await submit("initialize_router", [
  new Contract(router).call(
    "initialize",
    Address.fromString(factory).toScVal(),
  ),
]);
const assets = ["MKA", "MKB", "MKOUT"].map(
  (code) => new Asset(code, admin.publicKey()),
);
const tokens = assets.map((a) => a.contractId(passphrase));
for (let n = 0; n < assets.length; n++)
  await submit("create_asset_" + n, [
    Operation.createStellarAssetContract({ asset: assets[n]! }),
  ]);
await submit(
  "trust_assets",
  assets.map((asset) => Operation.changeTrust({ asset, limit: "1000000000" })),
  owner,
  false,
);
for (let n = 0; n < tokens.length; n++)
  await submit(
    "mint_asset_" + n,
    [
      new Contract(tokens[n]!).call(
        "mint",
        Address.fromString(owner.publicKey()).toScVal(),
        nativeToScVal(1_000_000_000_000n, { type: "i128" }),
      ),
    ],
    admin,
  );
for (let n = 0; n < 2; n++)
  await submit("liquidity_" + n, [
    new Contract(router).call(
      "add_liquidity",
      Address.fromString(tokens[n]!).toScVal(),
      Address.fromString(tokens[2]!).toScVal(),
      nativeToScVal(100_000_000_000n, { type: "i128" }),
      nativeToScVal(100_000_000_000n, { type: "i128" }),
      nativeToScVal(1n, { type: "i128" }),
      nativeToScVal(1n, { type: "i128" }),
      Address.fromString(owner.publicKey()).toScVal(),
      nativeToScVal(BigInt((await latestLedger(server)).timestamp) + 300n, {
        type: "u64",
      }),
    ),
  ]);
const configs = tokens
  .slice(0, 2)
  .map((address) => ({ address: Address.fromString(address), strategies: [] }));
// Constructor metadata follows actual generated DeFindex ABI.
const configVals = configs.map((c) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("address", { type: "symbol" }),
      val: c.address.toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("strategies", { type: "symbol" }),
      val: xdr.ScVal.scvVec([]),
    }),
  ]),
);
const roles = xdr.ScVal.scvMap(
  [0, 1, 2, 3].map(
    (n) =>
      new xdr.ScMapEntry({
        key: nativeToScVal(n, { type: "u32" }),
        val: Address.fromString(admin.publicKey()).toScVal(),
      }),
  ),
);
const names = xdr.ScVal.scvMap(
  ["name", "symbol"].map(
    (n) =>
      new xdr.ScMapEntry({
        key: nativeToScVal(n, { type: "string" }),
        val: nativeToScVal(n === "name" ? "Mierkhat fixture" : "MVT", {
          type: "string",
        }),
      }),
  ),
);
const vault = await deploy("defindex_vault", [
  xdr.ScVal.scvVec(configVals),
  roles,
  nativeToScVal(0, { type: "u32" }),
  Address.fromString(admin.publicKey()).toScVal(),
  nativeToScVal(0, { type: "u32" }),
  Address.fromString(router).toScVal(),
  names,
  nativeToScVal(false),
]);
await submit("deposit", [
  new Contract(vault).call(
    "deposit",
    xdr.ScVal.scvVec(
      [10_000_000_000n, 10_000_000_000n].map((n) =>
        nativeToScVal(n, { type: "i128" }),
      ),
    ),
    xdr.ScVal.scvVec([1n, 1n].map((n) => nativeToScVal(n, { type: "i128" }))),
    Address.fromString(owner.publicKey()).toScVal(),
    nativeToScVal(false),
  ),
]);
async function read(address: string, method: string, args: xdr.ScVal[] = []) {
  const tx = new TransactionBuilder(
    await server.getAccount(owner.publicKey()),
    { fee: "10000", networkPassphrase: passphrase },
  )
    .addOperation(new Contract(address).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  assert(rpc.Api.isSimulationSuccess(sim) && sim.result, "ReadFailed");
  return sim.result.retval;
}
const pairs: string[] = [];
for (let n = 0; n < 2; n++)
  pairs.push(
    String(
      scValToNative(
        await read(router, "router_pair_for", [
          Address.fromString(tokens[n]!).toScVal(),
          Address.fromString(tokens[2]!).toScVal(),
        ]),
      ),
    ),
  );
const profile: DeploymentBundle["profile"] = {
  schema: 1,
  network_id: digest(new TextEncoder().encode(passphrase)),
  vault: { address: vault, wasm_hash: state.artifacts.defindex_vault },
  router: { address: router, wasm_hash: state.artifacts.soroswap_router },
  factory: { address: factory, wasm_hash: state.artifacts.soroswap_factory },
  settlement: tokens[2]!,
  assets: tokens.slice(0, 2).map((asset, n) => ({
    asset,
    pair: { address: pairs[n]!, wasm_hash: state.artifacts.soroswap_pair },
  })),
  max_seconds: 300,
  max_ledgers: 64,
};
const profileVal = new (await import("@stellar/stellar-sdk")).contract.Spec(
  JSON.parse(
    await readFile(
      resolve(root, "backend/sdk/src/generated/spec.json"),
      "utf8",
    ),
  ),
).nativeToScVal(
  nativeProfile(profile),
  xdr.ScSpecTypeDef.scSpecTypeUdt(
    new xdr.ScSpecTypeUdt({ name: "RouteProfile" }),
  ),
);
const guard = await deploy("mierkhat_guard", [profileVal]);
const b: DeploymentBundle = {
  environment: "testnet",
  epoch: "integration-fixture-v1",
  enabled: true,
  reviewed: true,
  networkPassphrase: passphrase,
  guard,
  guardWasmHash: state.artifacts.mierkhat_guard,
  profileHash: profileHash(profile),
  profile,
  tokens: tokens.map((address, n) => ({
    address,
    symbol: assets[n]!.code,
    decimals: 7,
  })),
  vaultName: "Mierkhat testnet fixture",
  shareDecimals: 7,
  feeCeilingStroops: "10000000",
};
// Enabled only in this harness; published registry stays empty until independent review.
state.bundle = { ...b, enabled: false, reviewed: false };
await save();
if (
  state.operations.guarded_success &&
  !state.operations.guarded_success.ledger
) {
  const bytes = await readFile(
    resolve(privateDir, "guarded_success.xdr"),
    "utf8",
  );
  const result = await wait(state.operations.guarded_success.hash, bytes);
  assert(result.status === "SUCCESS", "GuardedSuccessFailed");
  state.operations.guarded_success = {
    hash: state.operations.guarded_success.hash,
    ledger: result.ledger,
    fee: result.resultXdr.feeCharged.toString(),
  };
  state.receipt = await decodeReceipt(
    server,
    b,
    state.operations.guarded_success.hash,
  );
  await save();
}
if (!state.operations.guarded_success) {
  const ledger = await latestLedger(server);
  const draft: ExitDraft = {
    environment: "testnet",
    epoch: b.epoch,
    revision: 1,
    intent: {
      schema: 1,
      network_id: profile.network_id,
      guard,
      profile_hash: b.profileHash,
      intent_id: hex(randomBytes(32)),
      owner: owner.publicKey(),
      recipient: owner.publicKey(),
      shares: "1000000000",
      min_withdraw: ["1", "1"],
      min_swap: ["1", "1"],
      min_receive: "1",
      valid_before_time: (BigInt(ledger.timestamp) + 120n).toString(),
      valid_before_ledger: ledger.sequence + 24,
    },
  };
  const review = await prepareExit(draft, b, server);
  const tx = new Transaction(review.transactionXdr, passphrase);
  tx.sign(owner);
  const bytes = tx.toXDR(),
    hash = hex(tx.hash());
  await writeFile(resolve(privateDir, "guarded_success.xdr"), bytes, {
    mode: 0o600,
  });
  state.operations.guarded_success = { hash };
  state.authFixture = {
    unsignedXdr: review.transactionXdr,
    intent: draft.intent,
    observedAuthDigest: review.observedAuthDigest,
  };
  await save();
  const result = await wait(hash, bytes);
  assert(result.status === "SUCCESS", "GuardedSuccessFailed");
  state.operations.guarded_success = {
    hash,
    ledger: result.ledger,
    fee: result.resultXdr.feeCharged.toString(),
  };
  state.receipt = await decodeReceipt(server, b, hash);
  await save();
}
if (
  state.operations.guarded_rollback &&
  !state.operations.guarded_rollback.ledger
) {
  const hash = state.operations.guarded_rollback.hash;
  const result = await wait(
    hash,
    await readFile(resolve(privateDir, "guarded_rollback.xdr"), "utf8"),
  );
  assert(result.status === "FAILED", "ExpectedOutcomeRejection");
  assert(state.rollbackBefore && state.rollbackKeys, "MissingRecoverySnapshot");
  const keys = state.rollbackKeys.map((k: string) =>
    xdr.LedgerKey.fromXDR(k, "base64"),
  );
  const entries = await server.getLedgerEntries(...keys);
  const after = Object.fromEntries(
    entries.entries
      .map((e) => [e.key.toXDR("base64"), e.val.toXDR("base64")])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
  );
  const beforeDigest = digest(
      new TextEncoder().encode(JSON.stringify(state.rollbackBefore)),
    ),
    afterDigest = digest(new TextEncoder().encode(JSON.stringify(after)));
  assert(beforeDigest === afterDigest, "PartialStateCommitted");
  state.rollback = {
    comparedEntries: Object.keys(after).length,
    beforeDigest,
    afterDigest,
    everyEntryEqual: true,
    expectedContractError: 1012,
  };
  state.operations.guarded_rollback = {
    hash,
    ledger: result.ledger,
    fee: result.resultXdr.feeCharged.toString(),
  };
  delete state.rollbackBefore;
  await save();
}
if (!state.operations.guarded_rollback) {
  const l = await latestLedger(server);
  const draft: ExitDraft = {
    environment: "testnet",
    epoch: b.epoch,
    revision: 1,
    intent: {
      schema: 1,
      network_id: profile.network_id,
      guard,
      profile_hash: b.profileHash,
      intent_id: hex(randomBytes(32)),
      owner: owner.publicKey(),
      recipient: owner.publicKey(),
      shares: "1000000000",
      min_withdraw: ["1", "1"],
      min_swap: ["1", "1"],
      min_receive: "1",
      valid_before_time: (BigInt(l.timestamp) + 120n).toString(),
      valid_before_ledger: l.sequence + 24,
    },
  };
  const review = await prepareExit(draft, b, server);
  const good = new Transaction(review.transactionXdr, passphrase);
  const goodOp = good.operations[0];
  assert(
    goodOp?.type === "invokeHostFunction" &&
      goodOp.func.type === "hostFunctionTypeInvokeContract",
    "FixtureOperation",
  );
  const badIntent = { ...draft.intent, min_receive: "2000000000" };
  const raw = new Contract(guard).call("execute_exit", intentScVal(badIntent));
  assert(
    raw.body.type === "invokeHostFunction" &&
      raw.body.invokeHostFunctionOp.hostFunction.type ===
        "hostFunctionTypeInvokeContract",
    "FixtureOperation",
  );
  const call = raw.body.invokeHostFunctionOp.hostFunction.invokeContract;
  const auth = (goodOp.auth ?? []).map(
    (a) =>
      new xdr.SorobanAuthorizationEntry({
        credentials: a.credentials,
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function:
            xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              call,
            ),
          subInvocations: a.rootInvocation.subInvocations,
        }),
      }),
  );
  const body = txV1(good);
  assert(body.ext.type === "sorobanData", "Resources");
  const data = body.ext.sorobanData;
  const keys = [
    ...data.resources.footprint.readOnly,
    ...data.resources.footprint.readWrite,
  ].filter((k) => k.type !== "account");
  const snapshot = async () => {
    const result = await server.getLedgerEntries(...keys);
    return Object.fromEntries(
      result.entries
        .map((e) => [e.key.toXDR("base64"), e.val.toXDR("base64")])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
  };
  const before = await snapshot();
  const tx = new TransactionBuilder(
    new Account(owner.publicKey(), (BigInt(good.sequence) - 1n).toString()),
    { fee: good.fee, networkPassphrase: passphrase },
  )
    .addOperation(
      Operation.invokeHostFunction({
        func: raw.body.invokeHostFunctionOp.hostFunction,
        auth,
      }),
    )
    .setTimebounds(0, Number(BigInt(badIntent.valid_before_time) - 1n))
    .setLedgerbounds(0, badIntent.valid_before_ledger)
    .setSorobanData(data)
    .build();
  tx.sign(owner);
  const bytes = tx.toXDR(),
    hash = hex(tx.hash());
  await writeFile(resolve(privateDir, "guarded_rollback.xdr"), bytes, {
    mode: 0o600,
  });
  state.operations.guarded_rollback = { hash };
  state.rollbackBefore = before;
  state.rollbackKeys = keys.map((k) => k.toXDR("base64"));
  await save();
  const result = await wait(hash, bytes);
  assert(result.status === "FAILED", "ExpectedOutcomeRejection");
  const after = await snapshot();
  const beforeDigest = digest(new TextEncoder().encode(JSON.stringify(before))),
    afterDigest = digest(new TextEncoder().encode(JSON.stringify(after)));
  assert(beforeDigest === afterDigest, "PartialStateCommitted");
  state.rollback = {
    comparedEntries: Object.keys(before).length,
    beforeDigest,
    afterDigest,
    everyEntryEqual: true,
    individualSwapMinima: ["1", "1"],
    totalMinimum: "2000000000",
    expectedContractError: 1012,
  };
  state.operations.guarded_rollback = {
    hash,
    ledger: result.ledger,
    fee: result.resultXdr.feeCharged.toString(),
  };
  state.resources = {
    ledger: l.sequence,
    sorobanData: data.toJSON(),
    maximumSignedFee: tx.fee,
  };
  delete state.rollbackBefore;
  await save();
  console.log("Signed rollback proof", hash);
}
if (!state.replayProof) {
  const l = await latestLedger(server);
  const draft: ExitDraft = {
    environment: "testnet",
    epoch: b.epoch,
    revision: 1,
    intent: {
      schema: 1,
      network_id: profile.network_id,
      guard,
      profile_hash: b.profileHash,
      intent_id: hex(randomBytes(32)),
      owner: owner.publicKey(),
      recipient: owner.publicKey(),
      shares: "1000000000",
      min_withdraw: ["1", "1"],
      min_swap: ["1", "1"],
      min_receive: "1",
      valid_before_time: (BigInt(l.timestamp) + 120n).toString(),
      valid_before_ledger: l.sequence + 24,
    },
  };
  if (!state.replayPair) {
    const review = await prepareExit(draft, b, server);
    const first = new Transaction(review.transactionXdr, passphrase);
    const body = txV1(first);
    const second = new Transaction(
      xdr.TransactionEnvelope.envelopeTypeTx(
        new xdr.TransactionV1Envelope({
          tx: new xdr.Transaction({
            ...body,
            seqNum: BigInt(first.sequence) + 1n,
          }),
          signatures: [],
        }),
      ),
      passphrase,
    );
    first.sign(owner);
    second.sign(owner);
    await writeFile(resolve(privateDir, "replay_first.xdr"), first.toXDR(), {
      mode: 0o600,
    });
    await writeFile(resolve(privateDir, "replay_second.xdr"), second.toXDR(), {
      mode: 0o600,
    });
    state.replayPair = {
      first: hex(first.hash()),
      second: hex(second.hash()),
      intentId: draft.intent.intent_id,
      validBeforeLedger: draft.intent.valid_before_ledger,
      validBeforeTime: draft.intent.valid_before_time,
    };
    await save();
  }
  const firstResult = await wait(
    state.replayPair.first,
    await readFile(resolve(privateDir, "replay_first.xdr"), "utf8"),
  );
  assert(firstResult.status === "SUCCESS", "ReplayFirstFailed");
  const secondResult = await wait(
    state.replayPair.second,
    await readFile(resolve(privateDir, "replay_second.xdr"), "utf8"),
  );
  assert(secondResult.status === "FAILED", "ReplayCommittedTwice");
  const firstTx = new Transaction(
    await readFile(resolve(privateDir, "replay_first.xdr"), "utf8"),
    passphrase,
  );
  const body = txV1(firstTx);
  assert(body.ext.type === "sorobanData", "Resources");
  const temporary = body.ext.sorobanData.resources.footprint.readWrite.filter(
    (k) =>
      k.type === "contractData" &&
      k.contractData.durability === xdr.ContractDataDurability.temporary &&
      Address.fromScAddress(k.contractData.contract).toString() === guard,
  );
  const entries = await server.getLedgerEntries(...temporary);
  assert(entries.entries.length > 0, "MissingReplayMarker");
  const liveUntil = Math.min(
    ...entries.entries.map((e) => e.liveUntilLedgerSeq ?? 0),
  );
  assert(
    liveUntil >= state.replayPair.validBeforeLedger + 1,
    "ReplayTTLTooShort",
  );
  state.replayProof = {
    ...state.replayPair,
    firstLedger: firstResult.ledger,
    secondLedger: secondResult.ledger,
    secondFee: secondResult.resultXdr.feeCharged.toString(),
    markerLiveUntilLedger: liveUntil,
    atMostOneCommitted: true,
  };
  delete state.replayPair;
  await save();
  console.log("Fresh-envelope replay rejected", state.replayProof.second);
}
console.log("Public testnet fixture saved:", evidencePath);
