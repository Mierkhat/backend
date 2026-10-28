import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { authDigest, verifyReview, verifySigned } from "./policy.js";
import {
  digest,
  intentHash,
  intentScVal,
  networkId,
  profileHash,
  bundleProfileHash,
  rootMethod,
} from "./codec.js";
import type { DeploymentBundle, ExitDraft, Review } from "./model.js";
export function sdkFixture(migration = false) {
  const address = (n: number) =>
    StrKey.encodeContract(new Uint8Array(32).fill(n));
  const key = Keypair.random();
  const profile: DeploymentBundle["profile"] = {
    schema: 1,
    network_id: networkId(Networks.TESTNET),
    vault: { address: address(1), wasm_hash: "01".repeat(32) },
    router: { address: address(2), wasm_hash: "02".repeat(32) },
    factory: { address: address(3), wasm_hash: "03".repeat(32) },
    settlement: address(4),
    assets: [
      {
        asset: address(5),
        pair: { address: address(6), wasm_hash: "06".repeat(32) },
      },
    ],
    max_seconds: 300,
    max_ledgers: 64,
  };
  const bundle: DeploymentBundle = {
    environment: "testnet",
    epoch: "fixture",
    enabled: true,
    reviewed: true,
    networkPassphrase: Networks.TESTNET,
    guard: address(7),
    guardWasmHash: "07".repeat(32),
    profileHash: profileHash(profile),
    profile,
    tokens: [
      { address: address(4), symbol: "OUT", decimals: 7 },
      { address: address(5), symbol: "IN", decimals: 7 },
    ],
    vaultName: "Fixture",
    shareDecimals: 7,
    feeCeilingStroops: "1000000",
  };
  if (migration) {
    bundle.migration = {
      destination: { address: address(8), wasm_hash: "08".repeat(32) },
      destination_assets: [{ asset: profile.settlement, pair: null }],
      destinationName: "Destination",
      destinationShareDecimals: 7,
    };
    bundle.profileHash = bundleProfileHash(bundle);
  }
  const draft: ExitDraft = {
    environment: "testnet",
    epoch: "fixture",
    revision: 1,
    intent: {
      schema: 1,
      network_id: profile.network_id,
      guard: bundle.guard,
      profile_hash: bundle.profileHash,
      intent_id: "08".repeat(32),
      owner: key.publicKey(),
      recipient: key.publicKey(),
      shares: "9007199254740993",
      ...(migration
        ? {
            migration: {
              convert_inputs: ["0"],
              min_deposit: ["1"],
              min_destination_shares: "1",
            },
          }
        : {}),
      min_withdraw: ["1"],
      min_swap: ["1"],
      min_receive: "1",
      valid_before_time: "1120",
      valid_before_ledger: 124,
    },
  };
  const raw = new Contract(bundle.guard).call(
    rootMethod(bundle),
    intentScVal(draft.intent),
  );
  if (
    raw.body.type !== "invokeHostFunction" ||
    raw.body.invokeHostFunctionOp.hostFunction.type !==
      "hostFunctionTypeInvokeContract"
  )
    throw Error("fixture");
  const root = raw.body.invokeHostFunctionOp.hostFunction.invokeContract;
  const child = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(profile.vault.address).toScAddress(),
    functionName: "transfer",
    args: [
      Address.fromString(key.publicKey()).toScVal(),
      Address.fromString(bundle.guard).toScVal(),
      nativeToScVal(BigInt(draft.intent.shares), { type: "i128" }),
    ],
  });
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          root,
        ),
      subInvocations: [
        new xdr.SorobanAuthorizedInvocation({
          function:
            xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              child,
            ),
          subInvocations: [],
        }),
      ],
    }),
  });
  const tx = new TransactionBuilder(new Account(key.publicKey(), "1"), {
    networkPassphrase: Networks.TESTNET,
    fee: "1000",
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: raw.body.invokeHostFunctionOp.hostFunction,
        auth: [auth],
      }),
    )
    .setTimebounds(0, 1119)
    .setLedgerbounds(0, 124)
    .setSorobanData(new SorobanDataBuilder().build())
    .build();
  const review: Review = {
    reviewId: null,
    draft,
    profile,
    transactionXdr: tx.toXDR(),
    envelopeDigest: digest(tx.toEnvelope().toXDR()),
    intentHash: intentHash(draft.intent),
    profileHash: bundle.profileHash,
    observedAuthDigest: authDigest(tx),
    preparedLedger: 100,
    preparedTime: "1000",
    expectedReceiveRaw: "100",
    feeMaximumStroops: tx.fee,
  };
  return {
    bundle,
    draft,
    review,
    key,
    tx,
    ledger: { sequence: 100, timestamp: "1000", sourceSequence: "1" },
  };
}
