import { describe, it, expect } from "vitest";
import { sdkFixture } from "./test-fixture.js";
import {
  validateBundle,
  validateIntent,
  verifyEnvelopePolicy,
  verifyReview,
  verifySigned,
} from "./policy.js";
import {
  decodeIntent,
  intentHash,
  intentScVal,
  bundleProfileHash,
} from "./codec.js";
import { inspectSigned } from "./submission.js";
import { minimumAfterMovement } from "./planning.js";
describe("migration domain and outcome binding", () => {
  it("roundtrips both domains and admits only the exact reviewed root and source share transfer", () => {
    for (const migration of [false, true]) {
      const f = sdkFixture(migration);
      validateBundle(f.bundle);
      verifyEnvelopePolicy(f.tx, f.draft, f.bundle);
      verifyReview(f.review, f.draft, f.bundle, f.ledger);
      expect(decodeIntent(intentScVal(f.draft.intent), f.bundle)).toEqual(
        f.draft.intent,
      );
      f.tx.sign(f.key);
      const signed = verifySigned(f.tx.toXDR(), f.review, f.bundle);
      expect(inspectSigned(signed.signedXdr, f.bundle).txHash).toBe(
        signed.txHash,
      );
    }
  });
  it("rejects a changed destination, missing bounds, excessive conversion budget and altered share floor", () => {
    const f = sdkFixture(true);
    const changed = structuredClone(f.bundle);
    changed.migration!.destination.address = f.bundle.profile.vault.address;
    changed.profileHash = bundleProfileHash(changed);
    expect(() => validateBundle(changed)).toThrow();
    const missing = structuredClone(f.draft);
    delete missing.intent.migration;
    expect(() => validateIntent(missing, f.bundle)).toThrow();
    const budget = structuredClone(f.draft);
    budget.intent.migration!.convert_inputs = ["2"];
    expect(() => validateIntent(budget, f.bundle)).toThrow();
    const floor = structuredClone(f.draft);
    floor.intent.migration!.min_destination_shares = "2";
    expect(intentHash(floor.intent)).not.toBe(intentHash(f.draft.intent));
    expect(() => verifyEnvelopePolicy(f.tx, floor, f.bundle)).toThrow();
    expect(() =>
      verifyEnvelopePolicy(sdkFixture().tx, f.draft, f.bundle),
    ).toThrow();
  });
  it("keeps integer precision and rejects unsupported movement bounds", () => {
    expect(minimumAfterMovement("900719925474099300", 50)).toBe(
      "896216325846728803",
    );
    expect(minimumAfterMovement("1", 50)).toBe("1");
    for (const value of [0, 501, 1.1, NaN])
      expect(() => minimumAfterMovement("100", value)).toThrow();
  });
});
