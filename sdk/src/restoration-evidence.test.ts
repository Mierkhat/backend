import { expect, it } from "vitest";
import { restorationEvidence, verifyRestorationAttempt } from "./restoration-evidence.js";
import { Transaction, xdr } from "@stellar/stellar-sdk";
import { restorationKeys, type SetupReview } from "./live.js";
import { digest } from "./codec.js";
import { sdkFixture } from "./test-fixture.js";
import { bundleSchema } from "./model.js";
import { txV1 } from "./policy.js";
import registry from "../deployments/index.json" with { type: "json" };
import fixture from "../fixtures/testnet-restore.json" with { type: "json" };
const identity = { network: "testnet", epoch: "epoch-a", guard: "guard-a", guardWasmHash: "code-a", profileHash: "profile-a" };
const live = { ledger: 100, entries: [{ key: "instance-a", status: "live", liveUntilLedger: 120 }] };
const missing = { ledger: 121, entries: [{ key: "instance-a", status: "missing_requires_archive_verification", liveUntilLedger: null }] };
const prior = { ...identity, ...restorationEvidence(identity, live, undefined) };
it("requires a recorded live TTL and actual expiry before marking an absent key", () => {
  expect(restorationEvidence(identity, missing, undefined).allMissingKeysHaveExpiryWitnesses).toBe(false);
  expect(restorationEvidence(identity, { ...missing, ledger: 120 }, prior).expiredKeys).toEqual([]);
  expect(restorationEvidence(identity, missing, prior).expiredKeys).toEqual(["instance-a"]);
  expect(restorationEvidence(identity, live, prior).allMissingKeysHaveExpiryWitnesses).toBe(false);
});
it("retains expiry witnesses through repeated missing observations", () => {
  const first = { ...identity, ...restorationEvidence(identity, missing, prior) };
  expect(restorationEvidence(identity, { ...missing, ledger: 122 }, first).allMissingKeysHaveExpiryWitnesses).toBe(true);
});
it("rejects changed network, epoch, executable, profile and ledger rollback", () => {
  for (const key of Object.keys(identity)) {
    expect(restorationEvidence({ ...identity, [key]: "changed" }, missing, prior).expiredKeys).toEqual([]);
  }
  expect(restorationEvidence(identity, { ...missing, ledger: 90 }, prior).expiryWitnesses).toEqual([]);
  expect(restorationEvidence(identity, missing, { ...prior, expiryWitnesses: "corrupt" }).expiredKeys).toEqual([]);
});
it("does not let a witnessed key prove unrelated absence or an extended TTL", () => {
  const extended = { ...identity, ...restorationEvidence(identity, {
    ...live, entries: [{ ...live.entries[0]!, liveUntilLedger: 200 }],
  }, prior) };
  expect(restorationEvidence(identity, missing, extended).expiredKeys).toEqual([]);
  const other = { ...missing, entries: [...missing.entries, { key: "never-seen", status: "missing", liveUntilLedger: null }] };
  expect(restorationEvidence(identity, other, prior).allMissingKeysHaveExpiryWitnesses).toBe(false);
});

it("resumes only the exact signed restoration with matching identity and expired footprint", () => {
  const bundle = bundleSchema.parse(registry[0]);
  const body = txV1(new Transaction(fixture.signedXdr, bundle.networkPassphrase));
  if (body.ext.type !== "sorobanData") throw Error("Fixture footprint missing");
  // The historical restore ran while entries were live and has an empty
  // footprint. Build a controlled signed case for a genuinely nonempty one.
  const ledgerKey = restorationKeys(bundle)[0]!, key = ledgerKey.toXDR("base64");
  const owner = sdkFixture().key;
  const data = body.ext.sorobanData;
  const unsigned = new Transaction(xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
    tx: new xdr.Transaction({ ...body, sourceAccount: xdr.MuxedAccount.keyTypeEd25519(owner.rawPublicKey()),
      ext: xdr.TransactionExt.sorobanData(new xdr.SorobanTransactionData({ ...data,
        resources: new xdr.SorobanResources({ ...data.resources,
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [ledgerKey] }),
        }),
      })),
    }), signatures: [],
  })), bundle.networkPassphrase);
  const review = structuredClone(fixture.review) as SetupReview;
  review.draft.owner = owner.publicKey(); review.transactionXdr = unsigned.toXDR();
  review.envelopeDigest = digest(unsigned.toEnvelope().toXDR());
  unsigned.sign(owner);
  const evidence = {
    network: bundle.networkPassphrase, epoch: bundle.epoch, guard: bundle.guard,
    guardWasmHash: bundle.guardWasmHash, profileHash: bundle.profileHash,
    before: { ledger: 121, entries: [{ key, status: "missing", liveUntilLedger: null }] },
    expiryWitnesses: [{ key, observedLiveLedger: 100, liveUntilLedger: 120 }],
  };
  const attempt = { signedXdr: unsigned.toXDR(), hash: Buffer.from(unsigned.hash()).toString("hex"), review, evidence };
  expect(verifyRestorationAttempt(attempt, bundle).signedXdr).toBe(attempt.signedXdr);
  for (const changed of [
    { ...attempt, hash: "00".repeat(32) },
    { ...attempt, signedXdr: "invalid" },
    { ...attempt, evidence: { ...evidence, epoch: "another-epoch" } },
    { ...attempt, evidence: { ...evidence, expiryWitnesses: [] } },
    { ...attempt, evidence: { ...evidence, before: { ledger: 121, entries: [{ key: "unrelated", status: "missing", liveUntilLedger: null }] }, expiryWitnesses: [{ key: "unrelated", observedLiveLedger: 100, liveUntilLedger: 120 }] } },
  ]) expect(() => verifyRestorationAttempt(changed, bundle)).toThrow();
});
