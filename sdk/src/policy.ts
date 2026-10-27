import {
  Address,
  Keypair,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { MierkhatError, rawAmount } from "./amount.js";
import {
  digest,
  hex,
  intentHash,
  intentScVal,
  networkId,
  profileHash,
} from "./codec.js";
import {
  bundleSchema,
  intentSchema,
  type DeploymentBundle,
  type ExitDraft,
  type Ledger,
  type Review,
  type SignedAttempt,
} from "./model.js";
export function assert(
  ok: unknown,
  code: string,
  copyKey = "route.changed",
): asserts ok {
  if (!ok) throw new MierkhatError(code, copyKey);
}
export function validateBundle(
  value: unknown,
  purpose: "sign" | "read" = "sign",
): DeploymentBundle {
  const b = bundleSchema.parse(value);
  assert(
    purpose === "read" ||
      (b.enabled && b.reviewed && b.environment !== "mainnet"),
    "DeploymentDisabled",
    "route.unsupported",
  );
  assert(
    networkId(b.networkPassphrase) === b.profile.network_id &&
      profileHash(b.profile) === b.profileHash,
    "ProfileHash",
  );
  const { profile: p } = b;
  const identities = [
    b.guard,
    p.vault.address,
    p.router.address,
    p.factory.address,
    ...p.assets.map((a) => a.pair?.address).filter(Boolean),
  ];
  assert(new Set(identities).size === identities.length, "Alias");
  const assets = p.assets.map((a) => a.asset);
  assert(
    new Set(assets).size === assets.length &&
      !assets.some((a) => identities.includes(a)) &&
      !identities.includes(p.settlement),
    "Alias",
  );
  for (const a of p.assets)
    assert(
      a.asset === p.settlement ? a.pair === null : a.pair !== null,
      "PairShape",
    );
  const required = new Set([...assets, p.settlement]);
  assert(
    b.tokens.length === required.size &&
      new Set(b.tokens.map((t) => t.address)).size === required.size &&
      b.tokens.every((t) => required.has(t.address)),
    "TokenMetadata",
  );
  rawAmount(b.feeCeilingStroops);
  return b;
}
export function validateIntent(
  draft: ExitDraft,
  b: DeploymentBundle,
  ledger?: Ledger,
) {
  const i = intentSchema.parse(draft.intent);
  assert(
    draft.environment === b.environment &&
      draft.epoch === b.epoch &&
      draft.revision > 0 &&
      Number.isSafeInteger(draft.revision),
    "DraftDomain",
  );
  assert(
    i.network_id === networkId(b.networkPassphrase) &&
      i.guard === b.guard &&
      i.profile_hash === b.profileHash,
    "WrongDomain",
  );
  assert(i.owner === i.recipient, "Recipient");
  rawAmount(i.shares);
  rawAmount(i.min_receive);
  assert(
    i.min_withdraw.length === b.profile.assets.length &&
      i.min_swap.length === b.profile.assets.length,
    "VectorShape",
  );
  b.profile.assets.forEach((a, n) => {
    rawAmount(i.min_withdraw[n]!);
    const m = rawAmount(i.min_swap[n]!, false);
    assert(a.asset === b.profile.settlement ? m === 0n : m > 0n, "SwapMinimum");
  });
  assert(BigInt(i.valid_before_time) <= (1n << 64n) - 1n, "TimeOverflow");
  if (ledger) {
    assert(
      ledger.sequence < i.valid_before_ledger &&
        BigInt(ledger.timestamp) < BigInt(i.valid_before_time),
      "Expired",
      "review.expired",
    );
    assert(
      i.valid_before_ledger - ledger.sequence <= 64 &&
        BigInt(i.valid_before_time) - BigInt(ledger.timestamp) <= 300n,
      "DeadlineTooFar",
    );
  }
}
export function decodeEnvelope(
  xdrText: string,
  passphrase: string,
): Transaction {
  assert(
    xdrText.length <= 350000 && /^[A-Za-z0-9+/]+={0,2}$/.test(xdrText),
    "BadEnvelope",
  );
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(xdrText, passphrase);
  } catch {
    throw new MierkhatError("BadEnvelope", "failure.authority");
  }
  assert(
    tx instanceof Transaction && tx.toEnvelope().type === "envelopeTypeTx",
    "UnsupportedEnvelope",
  );
  assert(tx.toXDR() === xdrText, "NonCanonicalEnvelope", "failure.authority");
  return tx;
}
export function txV1(tx: Transaction) {
  const e = tx.toEnvelope();
  assert(e.type === "envelopeTypeTx", "Envelope");
  return e.v1.tx;
}
export function unsignedBody(tx: Transaction): string {
  return txV1(tx).toXDR("base64");
}
export function authDigest(tx: Transaction): string {
  const op = tx.operations[0];
  assert(op?.type === "invokeHostFunction", "Operation");
  return digest(
    new TextEncoder().encode(
      (op.auth ?? []).map((a) => a.toXDR("base64")).join(":"),
    ),
  );
}
export function verifyEnvelopePolicy(
  tx: Transaction,
  draft: ExitDraft,
  b: DeploymentBundle,
): void {
  validateIntent(draft, b);
  const i = draft.intent;
  assert(
    tx.source === i.owner &&
      tx.memo.type === "none" &&
      tx.operations.length === 1,
    "SourceOrOperations",
  );
  const op = tx.operations[0]!;
  assert(op.type === "invokeHostFunction" && !op.source, "OperationSource");
  assert(op.func.type === "hostFunctionTypeInvokeContract", "HostFunction");
  const call = op.func.invokeContract;
  assert(
    Address.fromScAddress(call.contractAddress).toString() === b.guard &&
      call.functionName.toString() === "execute_exit",
    "Root",
  );
  assert(
    call.args.length === 1 &&
      call.args[0]!.toXDR("base64") === intentScVal(i).toXDR("base64"),
    "IntentMutation",
  );
  assert(
    tx.timeBounds &&
      BigInt(tx.timeBounds.maxTime) > 0n &&
      BigInt(tx.timeBounds.maxTime) < BigInt(i.valid_before_time),
    "TimeBounds",
  );
  assert(
    tx.ledgerBounds &&
      tx.ledgerBounds.maxLedger > 0 &&
      tx.ledgerBounds.maxLedger <= i.valid_before_ledger,
    "LedgerBounds",
  );
  const pre = txV1(tx).cond;
  assert(pre.type === "precondV2", "Preconditions");
  assert(
    pre.v2.extraSigners.length === 0 &&
      pre.v2.minSeqNum === null &&
      pre.v2.minSeqAge.toString() === "0" &&
      pre.v2.minSeqLedgerGap === 0,
    "ExtraPreconditions",
  );
  assert(txV1(tx).ext.type === "sorobanData", "MissingResources");
  assert(
    BigInt(tx.fee) > 0n && BigInt(tx.fee) <= BigInt(b.feeCeilingStroops),
    "FeeCeiling",
    "fee.changed",
  );
  assert((op.auth ?? []).length === 1, "AuthCount");
  for (const a of op.auth ?? []) {
    assert(
      a.credentials.type === "sorobanCredentialsSourceAccount",
      "CredentialMode",
    );
    const root = a.rootInvocation;
    assert(
      root.function.type === "sorobanAuthorizedFunctionTypeContractFn",
      "AuthRoot",
    );
    const r = root.function.contractFn;
    assert(r.toXDR("base64") === call.toXDR("base64"), "AuthRoot");
    assert(root.subInvocations.length === 1, "AuthChildren");
    const child = root.subInvocations[0]!;
    assert(
      child.subInvocations.length === 0 &&
        child.function.type === "sorobanAuthorizedFunctionTypeContractFn",
      "AuthChild",
    );
    const c = child.function.contractFn;
    const expected = [
      Address.fromString(i.owner).toScVal(),
      Address.fromString(b.guard).toScVal(),
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString((BigInt(i.shares) >> 64n).toString()),
          lo: xdr.Uint64.fromString(
            (BigInt(i.shares) & ((1n << 64n) - 1n)).toString(),
          ),
        }),
      ),
    ];
    assert(
      Address.fromScAddress(c.contractAddress).toString() ===
        b.profile.vault.address &&
        c.functionName.toString() === "transfer" &&
        c.args.length === 3 &&
        c.args.every(
          (v, n) => v.toXDR("base64") === expected[n]!.toXDR("base64"),
        ),
      "AuthTransfer",
    );
  }
}
export function verifyReview(
  candidate: Review,
  draft: ExitDraft,
  bundle: DeploymentBundle,
  ledger: Ledger,
): Review {
  const b = validateBundle(bundle);
  validateIntent(draft, b, ledger);
  assert(
    candidate.draft.revision === draft.revision &&
      candidate.draft.epoch === draft.epoch &&
      candidate.draft.environment === draft.environment &&
      intentHash(candidate.draft.intent) === intentHash(draft.intent),
    "StaleRevision",
    "review.stale",
  );
  assert(
    candidate.profileHash === b.profileHash &&
      profileHash(candidate.profile) === b.profileHash &&
      candidate.intentHash === intentHash(draft.intent),
    "Digest",
  );
  assert(
    candidate.preparedLedger <= ledger.sequence &&
      ledger.sequence - candidate.preparedLedger <= 4 &&
      BigInt(ledger.timestamp) >= BigInt(candidate.preparedTime) &&
      BigInt(ledger.timestamp) - BigInt(candidate.preparedTime) <= 20n,
    "StaleQuote",
    "review.stale",
  );
  const tx = decodeEnvelope(candidate.transactionXdr, b.networkPassphrase);
  assert(
    tx.signatures.length === 0 &&
      candidate.envelopeDigest === digest(tx.toEnvelope().toXDR()),
    "EnvelopeDigest",
  );
  verifyEnvelopePolicy(tx, draft, b);
  if (ledger.sourceSequence !== undefined)
    assert(
      BigInt(tx.sequence) === BigInt(ledger.sourceSequence) + 1n,
      "StaleSequence",
      "review.stale",
    );
  assert(
    candidate.observedAuthDigest === authDigest(tx) &&
      candidate.feeMaximumStroops === tx.fee,
    "FeeOrAuth",
  );
  rawAmount(candidate.expectedReceiveRaw);
  return structuredClone(candidate);
}
export function verifySigned(
  xdrText: string,
  review: Review,
  bundle: DeploymentBundle,
): SignedAttempt {
  const b = validateBundle(bundle);
  const signed = decodeEnvelope(xdrText, b.networkPassphrase);
  const unsigned = decodeEnvelope(review.transactionXdr, b.networkPassphrase);
  verifyEnvelopePolicy(signed, review.draft, b);
  assert(
    unsignedBody(signed) === unsignedBody(unsigned),
    "WalletMutation",
    "failure.authority",
  );
  const key = Keypair.fromPublicKey(review.draft.intent.owner);
  assert(signed.signatures.length === 1, "Signature", "failure.authority");
  const signature = signed.signatures[0]!;
  assert(
    signature.signature.toBytes().length === 64 &&
      hex(signature.hint.toBytes()) === hex(key.signatureHint()),
    "Signature",
    "failure.authority",
  );
  let valid = false;
  try {
    valid = key.verify(signed.hash(), signature.signature.toBytes());
  } catch {}
  assert(valid, "Signature", "failure.authority");
  return {
    environment: b.environment,
    epoch: b.epoch,
    txHash: Array.from(signed.hash(), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join(""),
    signedEnvelopeDigest: digest(signed.toEnvelope().toXDR()),
    signedXdr: xdrText,
    review,
  };
}
