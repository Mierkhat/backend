/** A deliberately failing, signed testnet migration. Compare every non-account
 * footprint value before/after. Exact signed bytes remain in the ignored directory. */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  accountState,
  assert,
  bundleSchema,
  digest,
  hex,
  intentScVal,
  quoteMigration,
  rootMethod,
  txV1,
  I128_MAX,
} from "../src/index.js";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const registry = (
  JSON.parse(
    await readFile(resolve(root, "backend/sdk/deployments/index.json"), "utf8"),
  ) as unknown[]
).map((v) => bundleSchema.parse(v));
const b = registry.find((b) => b.migration?.destination_assets.length === 2)!;
assert(
  b?.environment === "testnet" && b.networkPassphrase === Networks.TESTNET,
  "TestnetOnly",
);
const privateDir = resolve(root, ".tooling/testnet/migration-rollback");
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const evidence = resolve(
  root,
  "contracts/evidence/testnet-migration-rollback.json",
);
const key = Keypair.fromSecret(
  JSON.parse(
    await readFile(resolve(root, ".tooling/testnet/keys.json"), "utf8"),
  ).owner,
);
const server = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 20000,
});
type State = {
  hash: string;
  epoch: string;
  keys: string[];
  before: Record<string, string>;
  ledger?: number;
  observedErrors?: number[];
  beforeDigest?: string;
  afterDigest?: string;
  everyEntryEqual?: boolean;
  maximumSignedFee?: string;
  resources?: unknown;
  verifiedAt?: string;
};
let state: State;
try {
  state = JSON.parse(await readFile(evidence, "utf8"));
} catch {
  const account = await accountState(b, server, key.publicKey()),
    shares = (BigInt(account.sharesRaw!) / 1000n).toString();
  const quote = await quoteMigration(b, server, key.publicKey(), shares);
  const good = new Transaction(
      quote.review.transactionXdr,
      b.networkPassphrase,
    ),
    goodOp = good.operations[0];
  assert(goodOp?.type === "invokeHostFunction", "Operation");
  const bad = structuredClone(quote.draft.intent);
  bad.migration!.min_destination_shares = I128_MAX.toString();
  const operation = new Contract(b.guard).call(rootMethod(b), intentScVal(bad));
  assert(
    operation.body.type === "invokeHostFunction" &&
      operation.body.invokeHostFunctionOp.hostFunction.type ===
        "hostFunctionTypeInvokeContract",
    "Operation",
  );
  const host = operation.body.invokeHostFunctionOp.hostFunction,
    call = host.invokeContract;
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
  const rows = await server.getLedgerEntries(...keys);
  const before = Object.fromEntries(
    rows.entries
      .map((e) => [e.key.toXDR("base64"), e.val.toXDR("base64")])
      .sort((a, c) => a[0]!.localeCompare(c[0]!)),
  );
  const tx = new TransactionBuilder(
    new Account(key.publicKey(), (BigInt(good.sequence) - 1n).toString()),
    { fee: good.fee, networkPassphrase: b.networkPassphrase },
  )
    .addOperation(Operation.invokeHostFunction({ func: host, auth }))
    .setTimebounds(0, Number(BigInt(bad.valid_before_time) - 1n))
    .setLedgerbounds(0, bad.valid_before_ledger)
    .setSorobanData(data)
    .build();
  tx.sign(key);
  state = {
    hash: hex(tx.hash()),
    epoch: b.epoch,
    keys: keys.map((k) => k.toXDR("base64")),
    before,
    maximumSignedFee: tx.fee,
    resources: data.toJSON(),
  };
  await writeFile(resolve(privateDir, "rollback.xdr"), tx.toXDR(), {
    mode: 0o600,
  });
  await writeFile(evidence + ".tmp", JSON.stringify(state, null, 2) + "\n");
  await rename(evidence + ".tmp", evidence);
}
if (!state.ledger) {
  const bytes = await readFile(resolve(privateDir, "rollback.xdr"), "utf8"),
    tx = new Transaction(bytes, b.networkPassphrase);
  assert(hex(tx.hash()) === state.hash, "RecoveryHash");
  let result = await server.getTransaction(state.hash);
  if (result.status === "NOT_FOUND") await server.sendTransaction(tx);
  for (let n = 0; n < 45 && result.status === "NOT_FOUND"; n++) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await server.getTransaction(state.hash);
  }
  assert(result.status === "FAILED", "ExpectedCommittedFailure");
  const entries = await server.getLedgerEntries(
    ...state.keys.map((k) => xdr.LedgerKey.fromXDR(k, "base64")),
  );
  const after = Object.fromEntries(
    entries.entries
      .map((e) => [e.key.toXDR("base64"), e.val.toXDR("base64")])
      .sort((a, c) => a[0]!.localeCompare(c[0]!)),
  );
  const encode = (v: unknown) =>
    digest(new TextEncoder().encode(JSON.stringify(v)));
  const errors = new Set<number>();
  function visit(v: xdr.ScVal) {
    if (v.type === "scvError" && v.error.type === "sceContract")
      errors.add(v.error.contractCode);
    if (v.type === "scvVec") for (const item of v.vec ?? []) visit(item);
    if (v.type === "scvMap")
      for (const item of v.map ?? []) {
        visit(item.key);
        visit(item.val);
      }
  }
  if (result.resultMetaXdr.type === "v4")
    for (const event of result.resultMetaXdr.v4.diagnosticEvents) {
      if (event.event.body.type === "v0") {
        event.event.body.v0.topics.forEach(visit);
        visit(event.event.body.v0.data);
      }
    }
  assert(errors.has(1012), "ExpectedDestinationMinimumError");
  state = {
    ...state,
    ledger: result.ledger,
    observedErrors: [...errors],
    beforeDigest: encode(state.before),
    afterDigest: encode(after),
    everyEntryEqual: encode(state.before) === encode(after),
    verifiedAt: new Date().toISOString(),
  };
  assert(state.everyEntryEqual, "PartialActionStateCommitted");
  await writeFile(evidence + ".tmp", JSON.stringify(state, null, 2) + "\n");
  await rename(evidence + ".tmp", evidence);
}
console.log(
  "PASS signed testnet migration rollback",
  state.hash,
  "all",
  Object.keys(state.before).length,
  "footprint values unchanged; observed contract error1012",
);
