import { describe, it, expect } from "vitest";
import {
  Transaction,
  TransactionBuilder,
  Operation,
  xdr,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  verifySetup,
  verifySetupSigned,
  stellarAssets,
  type SetupReview,
} from "./live.js";
import { bundleSchema } from "./model.js";
import { txV1 } from "./policy.js";
import { digest } from "./codec.js";
import { parseAmount, formatAmount, I128_MAX } from "./amount.js";
import registry from "../deployments/index.json" with { type: "json" };
import restoreFixture from "../fixtures/testnet-restore.json" with { type: "json" };
import actual from "../fixtures/testnet-setup.json" with { type: "json" };
const b = bundleSchema.parse(registry[0]);
const reviews = actual.map((a) => ({ ...a, review: a.review as SetupReview }));
const clone = <T>(v: T): T => structuredClone(v);
describe("actual signed testnet setup policies", () => {
  it("verifies committed trustline and deposit envelopes and signatures", () => {
    for (const a of reviews) {
      expect(verifySetup(a.review, a.review.draft, b).source).toBe(
        a.review.draft.owner,
      );
      expect(verifySetupSigned(a.signedXdr, a.review, b).hash).toBe(a.hash);
    }
  });
  it("rejects altered assets, owner, desired amounts and minimums", () => {
    for (const a of reviews) {
      for (const change of [
        (r: SetupReview) => (r.draft.owner = b.guard),
        (r: SetupReview) =>
          r.draft.kind === "deposit"
            ? (r.draft.amountsRaw[0] = "999999999")
            : (r.draft.trustAssets[0] = b.guard),
        (r: SetupReview) =>
          r.draft.kind === "deposit"
            ? (r.draft.minimumsRaw[0] = "0")
            : r.draft.trustAssets.reverse(),
      ]) {
        const r = clone(a.review);
        change(r);
        expect(() => verifySetup(r, r.draft, b)).toThrow();
      }
    }
  });
  it("rejects wallet mutation and signatures from a different source", () => {
    for (const a of reviews) {
      const tx = new Transaction(a.signedXdr, b.networkPassphrase);
      const changed = TransactionBuilder.cloneFrom(tx, {
        fee: "10000001",
      }).build();
      expect(() => verifySetupSigned(changed.toXDR(), a.review, b)).toThrow();
      expect(() =>
        verifySetupSigned(a.review.transactionXdr, a.review, b),
      ).toThrow();
    }
  });
  it("rejects extra nested authorization and unrelated transfers despite matching digests", () => {
    const r = clone(
        reviews.find((a) => a.review.draft.kind === "deposit")!.review,
      ),
      tx = new Transaction(r.transactionXdr, b.networkPassphrase),
      op = tx.operations[0]!;
    if (op.type !== "invokeHostFunction") throw Error("fixture");
    const auth = op.auth![0]!,
      root = auth.rootInvocation;
    const badAuth = new xdr.SorobanAuthorizationEntry({
      credentials: auth.credentials,
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: root.function,
        subInvocations: [...root.subInvocations, ...root.subInvocations],
      }),
    });
    const body = txV1(tx);
    const changed = new Transaction(
      xdr.TransactionEnvelope.envelopeTypeTx(
        new xdr.TransactionV1Envelope({
          tx: new xdr.Transaction({
            ...body,
            operations: [
              Operation.invokeHostFunction({ func: op.func, auth: [badAuth] }),
            ],
          }),
          signatures: [],
        }),
      ),
      b.networkPassphrase,
    );
    r.transactionXdr = changed.toXDR();
    r.feeMaximumStroops = changed.fee;
    r.envelopeDigest = digest(changed.toEnvelope().toXDR());
    r.authDigest = digest(
      new TextEncoder().encode(JSON.stringify([[badAuth.toXDR("base64")]])),
    );
    expect(() => verifySetup(r, r.draft, b)).toThrow("DepositAuth");
  });
  it("rejects stale quote and sequence before a wallet prompt", () => {
    for (const { review: r } of reviews) {
      expect(() =>
        verifySetup(r, r.draft, b, {
          sequence: r.preparedLedger + 5,
          timestamp: r.preparedTime,
        }),
      ).toThrow();
      expect(() =>
        verifySetup(r, r.draft, b, {
          sequence: r.preparedLedger,
          timestamp: r.preparedTime,
          sourceSequence: "1",
        }),
      ).toThrow();
    }
  });
  it("derives exact SAC identities from the pinned issuer and refuses mainnet", () => {
    expect(
      stellarAssets(b).map((a) => a.contractId(b.networkPassphrase)),
    ).toEqual(b.tokens.map((t) => t.address));
    expect(() => stellarAssets({ ...b, environment: "mainnet" })).toThrow();
  });
});
it("roundtrips integer quantities across the full supported precision and i128 range with reproducible seed", () => {
  let seed = 1793009025558926593n;
  for (let n = 0; n < 6000; n++) {
    seed =
      (seed * 6364136223846793005n + 1442695040888963407n) &
      ((1n << 128n) - 1n);
    const amount = (seed % I128_MAX) + 1n,
      decimals = n % 39;
    expect(
      parseAmount(formatAmount(amount.toString(), decimals), decimals),
    ).toBe(amount.toString());
  }
  expect(() => parseAmount("1".repeat(100000), 7)).toThrow();
});

it("rejects seeded malformed XDR and single byte mutations of genuine signed envelopes", () => {
  let seed = 0x5e71a2c9;
  for (const a of reviews) {
    const original = Buffer.from(a.signedXdr, "base64");
    for (let n = 0; n < 600; n++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const bytes = Buffer.from(original),
        index = seed % bytes.length;
      bytes[index] = bytes[index]! ^ (1 << n % 8);
      expect(() =>
        verifySetupSigned(bytes.toString("base64"), a.review, b),
      ).toThrow();
    }
    for (const bytes of [
      original.subarray(0, original.length - 1),
      original.subarray(0, 10),
      Buffer.alloc(0),
    ])
      expect(() =>
        verifySetupSigned(bytes.toString("base64"), a.review, b),
      ).toThrow();
  }
}, 30000);

it("accepts actual committed restoration and rejects any unpinned restoration key", () => {
  const r = structuredClone(restoreFixture.review) as SetupReview;
  expect(verifySetupSigned(restoreFixture.signedXdr, r, b).hash).toBe(
    restoreFixture.hash,
  );
  const tx = new Transaction(r.transactionXdr, b.networkPassphrase),
    body = txV1(tx);
  if (body.ext.type !== "sorobanData") throw Error("fixture");
  const data = body.ext.sorobanData;
  const altered = new xdr.SorobanTransactionData({
    ...data,
    resources: new xdr.SorobanResources({
      ...data.resources,
      footprint: new xdr.LedgerFootprint({
        readOnly: [],
        readWrite: [
          xdr.LedgerKey.contractCode(
            new xdr.LedgerKeyContractCode({ hash: "ab".repeat(32) }),
          ),
        ],
      }),
    }),
  });
  const changed = new Transaction(
    xdr.TransactionEnvelope.envelopeTypeTx(
      new xdr.TransactionV1Envelope({
        tx: new xdr.Transaction({
          ...body,
          ext: xdr.TransactionExt.sorobanData(altered),
        }),
        signatures: [],
      }),
    ),
    b.networkPassphrase,
  );
  r.transactionXdr = changed.toXDR();
  r.envelopeDigest = digest(changed.toEnvelope().toXDR());
  expect(() => verifySetup(r, r.draft, b)).toThrow("RestoreFootprint");
});
