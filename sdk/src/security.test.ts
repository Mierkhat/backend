import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  Keypair,
  decodeAddressToMuxedAccount,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { ExitController } from "./controller.js";
import { formatAmount, I128_MAX, parseAmount, rawAmount } from "./amount.js";
import {
  digest,
  hex,
  intentScVal,
  jsonSafe,
  nativeProfile,
  profileScVal,
  spec,
  unhex,
} from "./codec.js";
import {
  authDigest,
  verifyReview,
  verifySigned,
  txV1,
  decodeEnvelope,
  verifyEnvelopePolicy,
} from "./policy.js";
import { sdkFixture } from "./test-fixture.js";
import type { WalletAdapter } from "./model.js";
describe("R16 amounts", () => {
  it("preserves unsafe JS integers and exact decimals", () => {
    expect(parseAmount("900719925.4740993", 7)).toBe("9007199254740993");
    expect(formatAmount("9007199254740993", 7)).toBe("900719925.4740993");
    expect(rawAmount(I128_MAX.toString())).toBe(I128_MAX);
  });
  it.each(["1e6", "1,000", "-1", "+1", "01", "1.", "NaN", "0", "1.00000001"])(
    "rejects ambiguous %s",
    (value) => expect(() => parseAmount(value, 7)).toThrow(),
  );
  it("bounds raw integers", () => {
    expect(() => rawAmount((I128_MAX + 1n).toString())).toThrow();
    expect(() => rawAmount(" 1")).toThrow();
  });
});
describe("R03/R15 envelope policy", () => {
  it("verifies source root auth and exact signature bytes", () => {
    const f = sdkFixture();
    expect(verifyReview(f.review, f.draft, f.bundle, f.ledger)).toEqual(
      f.review,
    );
    f.tx.sign(f.key);
    const a = verifySigned(f.tx.toXDR(), f.review, f.bundle);
    expect(a.txHash).toBe(hex(f.tx.hash()));
    expect(a.signedEnvelopeDigest).not.toBe(f.review.envelopeDigest);
    const wrongHint = f.key
      .signatureHint()
      .map((v, n) => (n === 0 ? v ^ 255 : v));
    const envelope = f.tx.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") throw Error("fixture");
    const altered = new Transaction(
      xdr.TransactionEnvelope.envelopeTypeTx(
        new xdr.TransactionV1Envelope({
          tx: envelope.v1.tx,
          signatures: [
            new xdr.DecoratedSignature({
              hint: wrongHint,
              signature: f.tx.signatures[0]!.signature,
            }),
          ],
        }),
      ),
      f.bundle.networkPassphrase,
    );
    expect(() => verifySigned(altered.toXDR(), f.review, f.bundle)).toThrow(
      "Signature",
    );
  });
  it("rejects fee/source/sequence/resources/operation mutation from wallet", () => {
    const f = sdkFixture();
    const body = txV1(f.tx);
    for (const patch of [
      { fee: 2000 },
      { memo: xdr.Memo.memoText("changed") },
      { seqNum: 99n },
      {
        sourceAccount: decodeAddressToMuxedAccount(
          Keypair.random().publicKey(),
        ),
      },
      { operations: [...body.operations, ...body.operations] },
      { ext: xdr.TransactionExt.v0() },
    ]) {
      const env = xdr.TransactionEnvelope.envelopeTypeTx(
        new xdr.TransactionV1Envelope({
          tx: new xdr.Transaction({ ...body, ...patch }),
          signatures: [],
        }),
      );
      const tx = new Transaction(env, f.bundle.networkPassphrase);
      tx.sign(f.key);
      expect(() => verifySigned(tx.toXDR(), f.review, f.bundle)).toThrow();
    }
  });
  it("rejects every altered bound and domain", () => {
    const f = sdkFixture();
    for (const patch of [
      { shares: "2" },
      { min_receive: "2" },
      { min_withdraw: ["2"] },
      { min_swap: ["2"] },
      { schema: 2 },
      { network_id: "09".repeat(32) },
      { profile_hash: "09".repeat(32) },
      { guard: f.bundle.profile.vault.address },
      { owner: Keypair.random().publicKey() },
      { recipient: f.bundle.guard },
      { valid_before_time: "1121" },
      { valid_before_ledger: 125 },
      { intent_id: "09".repeat(32) },
    ]) {
      const d = structuredClone(f.draft);
      Object.assign(d.intent, patch);
      expect(() => verifyReview(f.review, d, f.bundle, f.ledger)).toThrow();
    }
  });
  it("rejects stale and expired reviews", () => {
    const f = sdkFixture();
    expect(() =>
      verifyReview(f.review, f.draft, f.bundle, {
        sequence: 110,
        timestamp: "1021",
      }),
    ).toThrow();
    expect(() =>
      verifyReview(f.review, f.draft, f.bundle, {
        sequence: 124,
        timestamp: "1120",
      }),
    ).toThrow();
  });
});
describe("R01/R02 late async results", () => {
  it("discards stale prepare results", async () => {
    const f = sdkFixture(),
      c = new ExitController();
    c.setDraft(f.draft);
    let release!: (r: typeof f.review) => void;
    const p = c.prepare(() => new Promise((r) => (release = r)));
    c.invalidate();
    release(f.review);
    expect(await p).toBeUndefined();
  });
  it("discards a signature after leaving review and blocks a second prompt", async () => {
    const f = sdkFixture(),
      c = new ExitController();
    c.setDraft(f.draft);
    let release!: (v: string) => void;
    let opened!: (v: void) => void;
    const promptOpened = new Promise<void>((r) => (opened = r));
    const wallet: WalletAdapter = {
      identity: async () => ({
        address: f.key.publicKey(),
        networkPassphrase: f.bundle.networkPassphrase,
      }),
      sign: async () => {
        opened();
        return new Promise((r) => (release = r));
      },
    };
    const p = c.signExit(
      f.review,
      f.bundle,
      wallet,
      async () => f.ledger,
      async () => {},
    );
    await promptOpened;
    c.invalidate();
    const other = new ExitController();
    other.setDraft(f.draft);
    await expect(
      other.signExit(
        f.review,
        f.bundle,
        wallet,
        async () => f.ledger,
        async () => {},
      ),
    ).rejects.toThrow("PromptOpen");
    f.tx.sign(f.key);
    release(f.tx.toXDR());
    expect(await p).toBeUndefined();
  });
});

describe("compiled ABI vectors", () => {
  it("round trips Rust profile, intent and receipt XDR byte for byte", () => {
    const vector = JSON.parse(
      readFileSync(new URL("../fixtures/host.json", import.meta.url), "utf8"),
    );
    for (const [name, key] of [
      ["RouteProfile", "profile_xdr_hex"],
      ["ExitIntent", "intent_xdr_hex"],
      ["ExitReceipt", "receipt_xdr_hex"],
    ]) {
      const bytes = unhex(vector[key!]);
      const value = xdr.ScVal.fromXDR(bytes);
      const type = xdr.ScSpecTypeDef.scSpecTypeUdt(
        new xdr.ScSpecTypeUdt({ name: name! }),
      );
      expect(
        hex(spec.nativeToScVal(spec.scValToNative(value, type), type).toXDR()),
      ).toBe(vector[key!]);
    }
  });
  it("verifies the actual testnet simulation source-account auth fixture", () => {
    const vector = JSON.parse(
      readFileSync(
        new URL("../fixtures/testnet-auth.json", import.meta.url),
        "utf8",
      ),
    );
    const bundle = { ...vector.bundle, enabled: true, reviewed: true };
    const draft = {
      environment: bundle.environment,
      epoch: bundle.epoch,
      revision: 1,
      intent: vector.authFixture.intent,
    };
    const tx = decodeEnvelope(
      vector.authFixture.unsignedXdr,
      bundle.networkPassphrase,
    );
    expect(() => verifyEnvelopePolicy(tx, draft, bundle)).not.toThrow();
    expect(authDigest(tx)).toBe(vector.authFixture.observedAuthDigest);
  });
});
