import {
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  SorobanDataBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { reserveWalletPrompt } from "./controller.js";
import { rawAmount } from "./amount.js";
import { digest, hex } from "./codec.js";
import {
  assert,
  decodeEnvelope,
  txV1,
  unsignedBody,
  validateBundle,
} from "./policy.js";
import {
  archivedObservation,
  latestLedger,
  loadDeployment,
  readContract,
  reviewLedger,
} from "./rpc.js";
import type {
  DeploymentBundle,
  Ledger,
  Observation,
  WalletAdapter,
} from "./model.js";
export const TESTNET_ISSUER =
  "GBILTNMJALYUJZF2FRO44Y5HEO73ENGQHC4FBTF5AX2IPPDDDEF5UOI6";
export const TESTNET_READER =
  "GCAVTARGBNDGUCVBMXE2RU5OW5TBJZANS3UDPTMGDAECA3XYHGY77T5C";
export function stellarAssets(b: DeploymentBundle): Asset[] {
  assert(
    b.environment === "testnet" && b.networkPassphrase === Networks.TESTNET,
    "TestnetOnly",
  );
  return b.tokens.map((t) => {
    const a = new Asset(t.symbol, TESTNET_ISSUER);
    assert(a.contractId(b.networkPassphrase) === t.address, "AssetIdentity");
    return a;
  });
}
export interface AccountState {
  owner: string;
  funded: boolean;
  sequence?: string;
  nativeBalanceRaw?: string;
  sharesRaw?: string;
  tokens: {
    address: string;
    symbol: string;
    decimals: number;
    balanceRaw: string;
    trusted: boolean;
  }[];
  ledger: number;
}
export async function accountState(
  b: DeploymentBundle,
  s: rpc.Server,
  owner: string,
): Promise<AccountState> {
  const ledger = await latestLedger(s);
  const h = new Horizon.Server("https://horizon-testnet.stellar.org", {
    allowHttp: false,
  });
  let a: Awaited<ReturnType<typeof h.loadAccount>>;
  try {
    a = await h.loadAccount(owner);
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "response" in e &&
      (e.response as { status?: number })?.status === 404
    )
      return { owner, funded: false, tokens: [], ledger: ledger.sequence };
    throw e;
  }
  const assets = stellarAssets(b);
  return {
    owner,
    funded: true,
    sequence: a.sequence,
    nativeBalanceRaw: decimalRaw(
      a.balances.find((v) => v.asset_type === "native")!.balance,
    ),
    sharesRaw: String(
      scValToNative(
        await readContract(s, b, owner, b.profile.vault.address, "balance", [
          Address.fromString(owner).toScVal(),
        ]),
      ),
    ),
    tokens: b.tokens.map((t, n) => {
      const v = a.balances.find(
        (v) =>
          "asset_code" in v &&
          v.asset_code === assets[n]!.code &&
          v.asset_issuer === TESTNET_ISSUER,
      );
      return {
        ...t,
        trusted: !!v,
        balanceRaw: v ? decimalRaw(v.balance) : "0",
      };
    }),
    ledger: ledger.sequence,
  };
}
function decimalRaw(v: string): string {
  const [w, f = ""] = v.split(".");
  return (BigInt(w!) * 10000000n + BigInt(f.padEnd(7, "0"))).toString();
}
export interface NetworkState {
  ledger: number;
  closedAt: string;
  protocol: number;
  totalSharesRaw: string;
  assets: { address: string; balanceRaw: string }[];
  guard: string;
  profileHash: string;
}
export async function networkState(
  b: DeploymentBundle,
  s: rpc.Server,
): Promise<NetworkState> {
  const [l, n, supply, ...balances] = await Promise.all([
    s.getLatestLedger(),
    s.getNetwork(),
    readContract(s, b, TESTNET_READER, b.profile.vault.address, "total_supply"),
    ...b.profile.assets.map((a) =>
      readContract(s, b, TESTNET_READER, a.asset, "balance", [
        Address.fromString(b.profile.vault.address).toScVal(),
      ]),
    ),
  ]);
  assert(n.passphrase === b.networkPassphrase, "RpcNetwork");
  return {
    ledger: l.sequence,
    closedAt: l.closeTime,
    protocol: Number(n.protocolVersion),
    totalSharesRaw: String(scValToNative(supply)),
    assets: b.profile.assets.map((a, i) => ({
      address: a.asset,
      balanceRaw: String(scValToNative(balances[i]!)),
    })),
    guard: b.guard,
    profileHash: b.profileHash,
  };
}
export interface ExitQuote {
  sharesRaw: string;
  withdrawnRaw: string[];
  swappedRaw: string[];
  receiveRaw: string;
  ledger: number;
  timestamp: string;
}
export async function quoteExit(
  b: DeploymentBundle,
  s: rpc.Server,
  owner: string,
  shares: string,
): Promise<ExitQuote> {
  rawAmount(shares);
  await loadDeployment(b, s, owner);
  const l = await latestLedger(s);
  const amounts = scValToNative(
    await readContract(
      s,
      b,
      owner,
      b.profile.vault.address,
      "get_asset_amounts_per_shares",
      [nativeToScVal(BigInt(shares), { type: "i128" })],
    ),
  ) as bigint[];
  assert(
    amounts.length === b.profile.assets.length && amounts.every((v) => v > 0n),
    "QuoteAmount",
    "input.positive",
  );
  const swapped = await Promise.all(
    amounts.map(async (v, i) => {
      const asset = b.profile.assets[i]!.asset;
      if (asset === b.profile.settlement) return v;
      const path = xdr.ScVal.scvVec([
        Address.fromString(asset).toScVal(),
        Address.fromString(b.profile.settlement).toScVal(),
      ]);
      const q = scValToNative(
        await readContract(
          s,
          b,
          owner,
          b.profile.router.address,
          "router_get_amounts_out",
          [nativeToScVal(v, { type: "i128" }), path],
        ),
      ) as bigint[];
      assert(q.length === 2 && q[0] === v && q[1]! > 0n, "QuoteRoute");
      return q[1]!;
    }),
  );
  return {
    sharesRaw: shares,
    withdrawnRaw: amounts.map(String),
    swappedRaw: swapped.map(String),
    receiveRaw: swapped.reduce((a, v) => a + v, 0n).toString(),
    ledger: l.sequence,
    timestamp: l.timestamp,
  };
}
export type SetupKind = "trustlines" | "deposit" | "restore";
export interface SetupDraft {
  kind: SetupKind;
  owner: string;
  amountsRaw: string[];
  minimumsRaw: string[];
  trustAssets: string[];
}
export interface SetupReview {
  draft: SetupDraft;
  environment: "testnet";
  epoch: string;
  transactionXdr: string;
  envelopeDigest: string;
  authDigest: string;
  preparedLedger: number;
  preparedTime: string;
  expectedDepositedRaw: string[];
  expectedSharesRaw: string;
  feeMaximumStroops: string;
}
const authHash = (tx: Transaction) =>
  digest(
    new TextEncoder().encode(
      JSON.stringify(
        tx.operations.map((op) =>
          op.type === "invokeHostFunction"
            ? (op.auth ?? []).map((a) => a.toXDR("base64"))
            : [],
        ),
      ),
    ),
  );
function callFor(d: SetupDraft, b: DeploymentBundle): xdr.Operation {
  return new Contract(b.profile.vault.address).call(
    "deposit",
    xdr.ScVal.scvVec(
      d.amountsRaw.map((v) => nativeToScVal(BigInt(v), { type: "i128" })),
    ),
    xdr.ScVal.scvVec(
      d.minimumsRaw.map((v) => nativeToScVal(BigInt(v), { type: "i128" })),
    ),
    Address.fromString(d.owner).toScVal(),
    nativeToScVal(false),
  );
}
export function restorationKeys(bundle: DeploymentBundle): xdr.LedgerKey[] {
  const b = validateBundle(bundle),
    pins = [
      { address: b.guard, wasm_hash: b.guardWasmHash },
      b.profile.vault,
      b.profile.router,
      b.profile.factory,
      ...b.profile.assets.flatMap((a) => (a.pair ? [a.pair] : [])),
    ];
  const instances = [
    ...new Set([
      ...pins.map((p) => p.address),
      ...b.tokens.map((t) => t.address),
    ]),
  ].map((address) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(address).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  const code = [...new Set(pins.map((p) => p.wasm_hash))].map((hash) =>
    xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash })),
  );
  return [...instances, ...code];
}
export async function prepareSetup(
  d: SetupDraft,
  b: DeploymentBundle,
  s: rpc.Server,
): Promise<SetupReview> {
  if (d.kind !== "restore") await loadDeployment(b, s, d.owner);
  else
    assert(
      (await s.getNetwork()).passphrase === validateBundle(b).networkPassphrase,
      "RpcNetwork",
    );
  const l = await latestLedger(s),
    account = await s.getAccount(d.owner);
  const builder = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: b.networkPassphrase,
  })
    .setTimebounds(0, Number(BigInt(l.timestamp) + 180n))
    .setLedgerbounds(0, l.sequence + 36);
  let expectedDepositedRaw: string[] = [],
    expectedSharesRaw = "0";
  if (d.kind === "restore") {
    assert(
      d.amountsRaw.length === 0 &&
        d.minimumsRaw.length === 0 &&
        d.trustAssets.length === 0,
      "RestoreDraft",
    );
    builder
      .addOperation(Operation.restoreFootprint({}))
      .setSorobanData(
        new SorobanDataBuilder().setReadWrite(restorationKeys(b)).build(),
      );
  } else if (d.kind === "trustlines") {
    assert(
      d.amountsRaw.length === 0 &&
        d.minimumsRaw.length === 0 &&
        d.trustAssets.length > 0,
      "SetupDraft",
    );
    const assets = stellarAssets(b);
    for (const address of d.trustAssets) {
      const n = b.tokens.findIndex((t) => t.address === address);
      assert(n >= 0, "TrustAsset");
      builder.addOperation(
        Operation.changeTrust({ asset: assets[n]!, limit: "1000000000" }),
      );
    }
  } else {
    assert(
      d.kind === "deposit" &&
        d.trustAssets.length === 0 &&
        d.amountsRaw.length === b.profile.assets.length &&
        d.minimumsRaw.length === d.amountsRaw.length,
      "SetupDraft",
    );
    d.amountsRaw.forEach((v) => rawAmount(v));
    d.minimumsRaw.forEach((v, n) =>
      assert(
        rawAmount(v, false) <= rawAmount(d.amountsRaw[n]!),
        "DepositMinimum",
      ),
    );
    builder.addOperation(callFor(d, b));
  }
  let tx = builder.build();
  if (d.kind === "deposit" || d.kind === "restore") {
    const sim = await s.simulateTransaction(tx);
    assert(
      rpc.Api.isSimulationSuccess(sim) && !rpc.Api.isSimulationRestore(sim),
      "SetupRejected",
      d.kind === "restore" ? "restore.unavailable" : "deposit.rejected",
    );
    if (d.kind === "deposit") {
      assert(sim.result, "DepositRejected");
      const result = scValToNative(sim.result.retval) as [
        bigint[],
        bigint,
        unknown,
      ];
      expectedDepositedRaw = result[0].map(String);
      expectedSharesRaw = String(result[1]);
    }
    tx = rpc.assembleTransaction(tx, sim).build();
  }
  const r: SetupReview = {
    draft: structuredClone(d),
    environment: "testnet",
    epoch: b.epoch,
    transactionXdr: tx.toXDR(),
    envelopeDigest: digest(tx.toEnvelope().toXDR()),
    authDigest: authHash(tx),
    preparedLedger: l.sequence,
    preparedTime: l.timestamp,
    expectedDepositedRaw,
    expectedSharesRaw,
    feeMaximumStroops: tx.fee,
  };
  verifySetup(r, d, b, await reviewLedger(s, d.owner));
  return r;
}
export function verifySetup(
  r: SetupReview,
  d: SetupDraft,
  bundle: DeploymentBundle,
  l?: Ledger,
): Transaction {
  const b = validateBundle(bundle);
  stellarAssets(b);
  assert(
    r.environment === "testnet" &&
      r.epoch === b.epoch &&
      JSON.stringify(r.draft) === JSON.stringify(d),
    "SetupDomain",
  );
  const tx = decodeEnvelope(r.transactionXdr, b.networkPassphrase);
  assert(
    tx.signatures.length === 0 &&
      r.envelopeDigest === digest(tx.toEnvelope().toXDR()) &&
      r.authDigest === authHash(tx),
    "SetupDigest",
  );
  assert(
    tx.source === d.owner &&
      tx.memo.type === "none" &&
      tx.fee === r.feeMaximumStroops &&
      BigInt(tx.fee) > 0n &&
      BigInt(tx.fee) <= BigInt(b.feeCeilingStroops),
    "SetupEnvelope",
  );
  const cond = txV1(tx).cond;
  assert(
    cond.type === "precondV2" &&
      cond.v2.extraSigners.length === 0 &&
      cond.v2.minSeqNum === null &&
      cond.v2.minSeqAge === 0n &&
      cond.v2.minSeqLedgerGap === 0,
    "SetupPreconditions",
  );
  assert(
    tx.timeBounds &&
      BigInt(tx.timeBounds.minTime) === 0n &&
      BigInt(tx.timeBounds.maxTime) === BigInt(r.preparedTime) + 180n &&
      tx.ledgerBounds &&
      tx.ledgerBounds.minLedger === 0 &&
      tx.ledgerBounds.maxLedger === r.preparedLedger + 36,
    "SetupBounds",
  );
  if (l) {
    assert(
      l.sequence >= r.preparedLedger &&
        l.sequence - r.preparedLedger <= 4 &&
        BigInt(l.timestamp) >= BigInt(r.preparedTime) &&
        BigInt(l.timestamp) - BigInt(r.preparedTime) <= 20n,
      "StaleQuote",
      "review.stale",
    );
    if (l.sourceSequence !== undefined)
      assert(
        BigInt(tx.sequence) === BigInt(l.sourceSequence) + 1n,
        "StaleSequence",
        "review.stale",
      );
  }
  if (d.kind === "restore") {
    assert(
      d.amountsRaw.length === 0 &&
        d.minimumsRaw.length === 0 &&
        d.trustAssets.length === 0 &&
        r.expectedDepositedRaw.length === 0 &&
        r.expectedSharesRaw === "0",
      "RestoreDraft",
    );
    const op = tx.operations[0],
      ext = txV1(tx).ext;
    assert(
      tx.operations.length === 1 &&
        op?.type === "restoreFootprint" &&
        !op.source &&
        ext.type === "sorobanData",
      "RestoreOperation",
    );
    const footprint = ext.sorobanData.resources.footprint,
      expected = restorationKeys(b)
        .map((k) => k.toXDR("base64"))
        .sort(),
      actual = footprint.readWrite.map((k) => k.toXDR("base64")).sort();
    assert(
      footprint.readOnly.length === 0 &&
        new Set(actual).size === actual.length &&
        actual.every((key) => expected.includes(key)),
      "RestoreFootprint",
    );
  } else if (d.kind === "trustlines") {
    assert(
      d.amountsRaw.length === 0 &&
        d.minimumsRaw.length === 0 &&
        d.trustAssets.length > 0 &&
        d.trustAssets.length <= b.tokens.length &&
        new Set(d.trustAssets).size === d.trustAssets.length &&
        tx.operations.length === d.trustAssets.length,
      "TrustOperations",
    );
    const assets = stellarAssets(b);
    tx.operations.forEach((op, i) => {
      const n = b.tokens.findIndex((t) => t.address === d.trustAssets[i]);
      assert(
        n >= 0 &&
          op.type === "changeTrust" &&
          !op.source &&
          op.line instanceof Asset &&
          op.line.equals(assets[n]!) &&
          op.limit === "1000000000.0000000",
        "TrustMutation",
      );
    });
    assert(txV1(tx).ext.type === "v0", "TrustResources");
  } else {
    assert(
      d.kind === "deposit" &&
        d.trustAssets.length === 0 &&
        d.amountsRaw.length === b.profile.assets.length &&
        d.minimumsRaw.length === d.amountsRaw.length,
      "DepositDraft",
    );
    d.amountsRaw.forEach((v) => rawAmount(v));
    d.minimumsRaw.forEach((v, i) =>
      assert(
        rawAmount(v, false) <= rawAmount(d.amountsRaw[i]!),
        "DepositMinimum",
      ),
    );
    const op = tx.operations[0];
    assert(
      tx.operations.length === 1 &&
        op?.type === "invokeHostFunction" &&
        !op.source &&
        op.func.type === "hostFunctionTypeInvokeContract" &&
        txV1(tx).ext.type === "sorobanData",
      "DepositOperation",
    );
    const expected = callFor(d, b).body;
    assert(expected.type === "invokeHostFunction", "DepositOperation");
    assert(
      op.func.toXDR("base64") ===
        expected.invokeHostFunctionOp.hostFunction.toXDR("base64"),
      "DepositMutation",
    );
    assert(
      r.expectedDepositedRaw.length === d.amountsRaw.length &&
        rawAmount(r.expectedSharesRaw) > 0n &&
        (op.auth ?? []).length === 1,
      "DepositResult",
    );
    const a = op.auth![0]!,
      root = a.rootInvocation;
    assert(
      a.credentials.type === "sorobanCredentialsSourceAccount" &&
        root.function.type === "sorobanAuthorizedFunctionTypeContractFn" &&
        root.function.contractFn.toXDR("base64") ===
          op.func.invokeContract.toXDR("base64"),
      "DepositAuth",
    );
    assert(root.subInvocations.length === d.amountsRaw.length, "DepositAuth");
    root.subInvocations.forEach((c, i) => {
      const amount = rawAmount(r.expectedDepositedRaw[i]!);
      assert(
        amount <= rawAmount(d.amountsRaw[i]!) &&
          amount >= rawAmount(d.minimumsRaw[i]!, false) &&
          c.subInvocations.length === 0 &&
          c.function.type === "sorobanAuthorizedFunctionTypeContractFn",
        "DepositAuth",
      );
      const f = c.function.contractFn;
      assert(
        Address.fromScAddress(f.contractAddress).toString() ===
          b.profile.assets[i]!.asset &&
          f.functionName.toString() === "transfer",
        "DepositAuth",
      );
      const args = [
        Address.fromString(d.owner).toScVal(),
        Address.fromString(b.profile.vault.address).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ];
      assert(
        f.args.length === 3 &&
          f.args.every(
            (v, n) => v.toXDR("base64") === args[n]!.toXDR("base64"),
          ),
        "DepositAuth",
      );
    });
  }
  return tx;
}
export function verifySetupSigned(
  bytes: string,
  r: SetupReview,
  b: DeploymentBundle,
): { hash: string; digest: string } {
  const unsigned = verifySetup(r, r.draft, b),
    tx = decodeEnvelope(bytes, b.networkPassphrase);
  assert(
    unsignedBody(tx) === unsignedBody(unsigned),
    "WalletMutation",
    "failure.authority",
  );
  assert(tx.signatures.length === 1, "Signature");
  const sig = tx.signatures[0]!,
    key = Keypair.fromPublicKey(r.draft.owner);
  assert(
    hex(sig.hint.toBytes()) === hex(key.signatureHint()) &&
      sig.signature.toBytes().length === 64 &&
      key.verify(tx.hash(), sig.signature.toBytes()),
    "Signature",
  );
  return { hash: hex(tx.hash()), digest: digest(tx.toEnvelope().toXDR()) };
}
export async function signSetup(
  r: SetupReview,
  b: DeploymentBundle,
  s: rpc.Server,
  w: WalletAdapter,
): Promise<string> {
  const identity = await w.identity();
  assert(
    identity.address === r.draft.owner &&
      identity.networkPassphrase === b.networkPassphrase,
    "Identity",
    "wallet.changed",
  );
  if (r.draft.kind !== "restore") await loadDeployment(b, s, r.draft.owner);
  else
    assert(
      (await s.getNetwork()).passphrase === b.networkPassphrase,
      "RpcNetwork",
    );
  verifySetup(r, r.draft, b, await reviewLedger(s, r.draft.owner));
  const release = reserveWalletPrompt(identity.address);
  try {
    const bytes = await w.sign(
      r.transactionXdr,
      b.networkPassphrase,
      r.draft.owner,
    );
    const after = await w.identity();
    assert(
      after.address === identity.address &&
        after.networkPassphrase === identity.networkPassphrase,
      "Identity",
      "wallet.changed",
    );
    verifySetupSigned(bytes, r, b);
    return bytes;
  } finally {
    release();
  }
}
export async function transactionObservation(
  s: rpc.Server,
  b: DeploymentBundle,
  hash: string,
): Promise<Observation> {
  const r = await s.getTransaction(hash),
    base = { hash, observedAt: new Date().toISOString(), rawStatus: r.status };
  if (r.status === "NOT_FOUND")
    return (
      (await archivedObservation(b, hash)) ?? { ...base, state: "unknown" }
    );
  const tx = decodeEnvelope(r.envelopeXdr.toXDR("base64"), b.networkPassphrase);
  assert(hex(tx.hash()) === hash, "LookupHash");
  return {
    ...base,
    state: r.status === "SUCCESS" ? "succeeded" : "failed",
    ledger: r.ledger,
    actualFee: r.resultXdr.feeCharged.toString(),
  };
}
