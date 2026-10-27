import {
  Account,
  Address,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  assert,
  authDigest,
  decodeEnvelope,
  validateBundle,
  validateIntent,
  verifyEnvelopePolicy,
  verifyReview,
  verifySigned,
} from "./policy.js";
import {
  digest,
  hex,
  intentHash,
  intentScVal,
  jsonSafe,
  profileHash,
  spec,
} from "./codec.js";
import {
  type DeploymentBundle,
  type ExitIntent,
  type ExitDraft,
  type Ledger,
  type Observation,
  type Receipt,
  type Review,
  type SignedAttempt,
} from "./model.js";
export { rpc } from "@stellar/stellar-sdk";
export async function latestLedger(server: rpc.Server): Promise<Ledger> {
  const l = await server.getLatestLedger();
  return { sequence: l.sequence, timestamp: l.closeTime };
}
export async function reviewLedger(
  server: rpc.Server,
  owner: string,
): Promise<Ledger & { sourceSequence: string }> {
  const [ledger, account] = await Promise.all([
    latestLedger(server),
    server.getAccount(owner),
  ]);
  return { ...ledger, sourceSequence: account.sequenceNumber() };
}
export async function readContract(
  server: rpc.Server,
  b: DeploymentBundle,
  owner: string,
  contract: string,
  method: string,
  args: xdr.ScVal[] = [],
  source?: Account,
): Promise<xdr.ScVal> {
  const account = source
    ? new Account(owner, source.sequenceNumber())
    : await server.getAccount(owner);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: b.networkPassphrase,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  assert(
    rpc.Api.isSimulationSuccess(sim) &&
      !rpc.Api.isSimulationRestore(sim) &&
      sim.result,
    "ReadUnavailable",
    "service.unavailable",
  );
  return sim.result.retval;
}
export async function loadDeployment(
  value: DeploymentBundle,
  server: rpc.Server,
  owner: string,
): Promise<DeploymentBundle> {
  const b = validateBundle(value);
  const net = await server.getNetwork();
  assert(net.passphrase === b.networkPassphrase, "RpcNetwork", "network.wrong");
  const pins = [
    { address: b.guard, wasm_hash: b.guardWasmHash },
    b.profile.vault,
    b.profile.router,
    b.profile.factory,
    ...b.profile.assets.flatMap((a) => (a.pair ? [a.pair] : [])),
  ];
  const contracts = [
    ...pins.map((p) => p.address),
    ...b.tokens.map((t) => t.address),
  ];
  const keys = contracts.map((address) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(address).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  const entries = await server.getLedgerEntries(...keys);
  for (let n = 0; n < keys.length; n++) {
    const entry = entries.entries.find(
      (e) => e.key.toXDR("base64") === keys[n]!.toXDR("base64"),
    )?.val;
    assert(
      entry?.type === "contractData" &&
        entry.contractData.val.type === "scvContractInstance",
      "MissingDependency",
    );
    const executable = entry.contractData.val.instance.executable;
    if (n < pins.length)
      assert(
        executable.type === "contractExecutableWasm" &&
          executable.wasmHash.toString() === pins[n]!.wasm_hash,
        "CodeChanged",
      );
    else
      assert(
        executable.type === "contractExecutableStellarAsset",
        "UnsupportedAsset",
      );
  }
  const source = await server.getAccount(owner);
  await Promise.all(
    b.tokens.map(async (token) => {
      const [decimals, symbol] = await Promise.all(
        ["decimals", "symbol"].map((method) =>
          readContract(server, b, owner, token.address, method, [], source),
        ),
      );
      assert(
        scValToNative(decimals!) === token.decimals &&
          scValToNative(symbol!) === token.symbol,
        "MetadataChanged",
      );
    }),
  );
  const [onchainProfile, shareDecimals] = await Promise.all([
    readContract(server, b, owner, b.guard, "profile", [], source),
    readContract(
      server,
      b,
      owner,
      b.profile.vault.address,
      "decimals",
      [],
      source,
    ),
  ]);
  assert(digest(onchainProfile.toXDR()) === b.profileHash, "ProfileChanged");
  assert(scValToNative(shareDecimals) === b.shareDecimals, "ShareDecimals");
  const account = await server.getAccountEntry(owner);
  const thresholds = account.thresholds.toBytes();
  assert(
    account.signers.length === 0 &&
      thresholds[0] === 1 &&
      thresholds.slice(1).every((t) => t <= 1),
    "UnsupportedAccount",
    "failure.authority",
  );
  return b;
}
export async function shareBalance(
  b: DeploymentBundle,
  server: rpc.Server,
  owner: string,
): Promise<string> {
  return String(
    scValToNative(
      await readContract(server, b, owner, b.profile.vault.address, "balance", [
        Address.fromString(owner).toScVal(),
      ]),
    ),
  );
}
export function createExitDraft(input: {
  environment: ExitDraft["environment"];
  epoch: string;
  intent: Omit<ExitIntent, "intent_id"> & { intent_id?: string };
}): ExitDraft {
  return {
    ...input,
    intent: {
      ...input.intent,
      intent_id: input.intent.intent_id ?? newIntentId(),
    },
    revision: 1,
  };
}
export function newIntentId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
export async function prepareExit(
  draft: ExitDraft,
  bundle: DeploymentBundle,
  server: rpc.Server,
): Promise<Review> {
  const b = await loadDeployment(bundle, server, draft.intent.owner);
  const ledger = await latestLedger(server);
  validateIntent(draft, b, ledger);
  const account = await server.getAccount(draft.intent.owner);
  const maxTime = BigInt(draft.intent.valid_before_time) - 1n;
  assert(maxTime <= BigInt(Number.MAX_SAFE_INTEGER), "TimeOverflow");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: b.networkPassphrase,
  })
    .addOperation(
      new Contract(b.guard).call("execute_exit", intentScVal(draft.intent)),
    )
    .setTimebounds(0, Number(maxTime))
    .setLedgerbounds(0, draft.intent.valid_before_ledger)
    .build();
  const sim = await server.simulateTransaction(tx);
  assert(
    rpc.Api.isSimulationSuccess(sim) &&
      !rpc.Api.isSimulationRestore(sim) &&
      sim.result,
    "SimulationRejected",
    "route.unsupported",
  );
  const assembled = rpc.assembleTransaction(tx, sim).build();
  verifyEnvelopePolicy(assembled, draft, b);
  const estimate = decodeContractReceipt(sim.result.retval);
  const review: Review = {
    reviewId: null,
    draft: structuredClone(draft),
    profile: b.profile,
    transactionXdr: assembled.toXDR(),
    envelopeDigest: digest(assembled.toEnvelope().toXDR()),
    intentHash: intentHash(draft.intent),
    profileHash: b.profileHash,
    observedAuthDigest: authDigest(assembled),
    preparedLedger: ledger.sequence,
    preparedTime: ledger.timestamp,
    expectedReceiveRaw: estimate.received,
    feeMaximumStroops: assembled.fee,
  };
  return verifyReview(
    review,
    draft,
    b,
    await reviewLedger(server, draft.intent.owner),
  );
}
export function decodeContractReceipt(value: xdr.ScVal): Receipt {
  const v = jsonSafe(spec.funcResToNative("execute_exit", value)) as Record<
    string,
    unknown
  >;
  assert(
    v &&
      typeof v === "object" &&
      typeof v.received === "string" &&
      typeof v.shares_spent === "string",
    "Receipt",
  );
  return {
    intentId: String(v.intent_id),
    intentHash: String(v.intent_hash),
    profileHash: String(v.profile_hash),
    owner: String(v.owner),
    sharesSpent: v.shares_spent,
    received: v.received,
    withdrawn: v.withdrawn as string[],
    swappedOut: v.swapped_out as string[],
    ledger: Number(v.ledger),
    timestamp: String(v.timestamp),
  };
}
export async function decodeReceipt(
  server: rpc.Server,
  bundle: DeploymentBundle,
  hash: string,
): Promise<Observation> {
  const b = validateBundle(bundle, "read");
  const result = await server.getTransaction(hash);
  const base = {
    hash,
    observedAt: new Date().toISOString(),
    rawStatus: result.status,
  };
  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND)
    return { ...base, state: "unknown" };
  const tx = decodeEnvelope(
    result.envelopeXdr.toXDR("base64"),
    b.networkPassphrase,
  );
  assert(hex(tx.hash()) === hash, "LookupHash");
  if (result.status === rpc.Api.GetTransactionStatus.FAILED)
    return {
      ...base,
      state: "failed",
      ledger: result.ledger,
      actualFee: result.resultXdr.feeCharged.toString(),
    };
  let receipt: Receipt | undefined;
  try {
    assert(result.returnValue, "MissingReceipt");
    receipt = decodeContractReceipt(result.returnValue);
    const op = tx.operations[0];
    assert(
      op?.type === "invokeHostFunction" &&
        op.func.type === "hostFunctionTypeInvokeContract",
      "Root",
    );
    const call = op.func.invokeContract;
    assert(
      Address.fromScAddress(call.contractAddress).toString() === b.guard &&
        call.functionName.toString() === "execute_exit" &&
        call.args.length === 1,
      "ReceiptRoot",
    );
    const i = jsonSafe(
      spec.scValToNative(
        call.args[0]!,
        xdr.ScSpecTypeDef.scSpecTypeUdt(
          new xdr.ScSpecTypeUdt({ name: "ExitIntent" }),
        ),
      ),
    ) as ExitDraft["intent"];
    const d: ExitDraft = {
      environment: b.environment,
      epoch: b.epoch,
      revision: 1,
      intent: i,
    };
    verifyEnvelopePolicy(tx, d, b);
    assert(
      receipt.profileHash === b.profileHash &&
        receipt.intentHash === intentHash(i) &&
        receipt.intentId === i.intent_id &&
        receipt.owner === i.owner &&
        receipt.sharesSpent === i.shares &&
        BigInt(receipt.received) >= BigInt(i.min_receive) &&
        receipt.ledger === result.ledger,
      "ReceiptMismatch",
    );
  } catch {
    receipt = undefined;
  }
  return {
    ...base,
    state: "succeeded",
    ledger: result.ledger,
    actualFee: result.resultXdr.feeCharged.toString(),
    receipt,
  };
}
export async function submitExit(
  attempt: SignedAttempt,
  b: DeploymentBundle,
  server: rpc.Server,
  persist: (attempt: SignedAttempt) => Promise<void>,
): Promise<Observation> {
  const verified = verifySigned(attempt.signedXdr, attempt.review, b);
  assert(
    verified.txHash === attempt.txHash &&
      verified.signedEnvelopeDigest === attempt.signedEnvelopeDigest,
    "AttemptDigest",
  );
  await persist(attempt); // R06/R07: failure here means no network send.
  try {
    const result = await server.sendTransaction(
      decodeEnvelope(attempt.signedXdr, b.networkPassphrase),
    );
    return {
      state:
        result.status === "PENDING" || result.status === "DUPLICATE"
          ? "pending"
          : "unknown",
      hash: attempt.txHash,
      observedAt: new Date().toISOString(),
      rawStatus: result.status,
    };
  } catch {
    return {
      state: "unknown",
      hash: attempt.txHash,
      observedAt: new Date().toISOString(),
    };
  }
}
export async function* watchExit(
  hash: string,
  lookup: () => Promise<Observation>,
  signal: AbortSignal,
): AsyncGenerator<Observation> {
  let n = 0;
  while (!signal.aborted) {
    let observation: Observation;
    try {
      observation = await lookup();
    } catch {
      observation = {
        hash,
        state: "unknown",
        observedAt: new Date().toISOString(),
      };
    }
    if (signal.aborted) return;
    yield observation;
    if (observation.state === "succeeded" || observation.state === "failed")
      return;
    const delay =
      n++ < 16 ? Math.min(4000, 1000 * 2 ** Math.min(n - 1, 2)) : 15000;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
