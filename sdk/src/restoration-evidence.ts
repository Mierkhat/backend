import { z } from "zod";
import { Transaction } from "@stellar/stellar-sdk";
import type { DeploymentBundle } from "./model.js";
import { verifySetupSigned, type SetupReview } from "./live.js";
import { assert, txV1 } from "./policy.js";

const identitySchema = z.object({
  network: z.string(), epoch: z.string(), guard: z.string(),
  guardWasmHash: z.string(), profileHash: z.string(),
});
const ledgerSchema = z.number().int().nonnegative().safe();
const witnessSchema = z.object({
  key: z.string(), observedLiveLedger: ledgerSchema, liveUntilLedger: ledgerSchema,
});
export type RestorationIdentity = z.infer<typeof identitySchema>;
export interface RestorationSnapshot {
  ledger: number;
  entries: { key: string; status: string; liveUntilLedger: number | null }[];
}
const snapshotSchema = z.object({
  ledger: ledgerSchema,
  entries: z.array(z.object({ key: z.string(), status: z.string(), liveUntilLedger: ledgerSchema.nullable() })),
});
const resumeSchema = z.object({
  signedXdr: z.string(), hash: z.string(), review: z.unknown(),
  evidence: identitySchema.extend({ before: snapshotSchema, expiryWitnesses: z.array(witnessSchema) }).passthrough(),
});

export function verifyRestorationAttempt(value: unknown, bundle: DeploymentBundle) {
  const pending = resumeSchema.parse(value), review = pending.review as SetupReview;
  const signed = verifySetupSigned(pending.signedXdr, review, bundle);
  assert(review.draft.kind === "restore" && signed.hash === pending.hash, "RestorationAttemptMismatch");
  const identity = {
    network: bundle.networkPassphrase, epoch: bundle.epoch, guard: bundle.guard,
    guardWasmHash: bundle.guardWasmHash, profileHash: bundle.profileHash,
  };
  assert(Object.keys(identity).every((key) =>
    identity[key as keyof RestorationIdentity] === pending.evidence[key as keyof RestorationIdentity],
  ), "RestorationIdentityMismatch");
  const proof = restorationEvidence(identity, pending.evidence.before, pending.evidence);
  assert(proof.allMissingKeysHaveExpiryWitnesses, "ArchiveEvidenceRequired");
  const body = txV1(new Transaction(pending.signedXdr, bundle.networkPassphrase));
  assert(body.ext.type === "sorobanData", "RestoreFootprint");
  const restoredKeys = body.ext.sorobanData.resources.footprint.readWrite.map((key) => key.toXDR("base64"));
  assert(proof.expiredKeys.every((key) => restoredKeys.includes(key)), "RestoreFootprint");
  return { ...pending, review };
}

/** An absent key is not archival proof. Retain a bound live/TTL observation
 * across checks, rejecting incompatible identities and ledger rollback. */
export function restorationEvidence(
  identity: RestorationIdentity,
  snapshot: RestorationSnapshot,
  prior: unknown,
) {
  const parsed = identitySchema.extend({ expiryWitnesses: z.array(witnessSchema) }).safeParse(prior);
  const witnesses = new Map<string, z.infer<typeof witnessSchema>>();
  if (parsed.success && Object.keys(identity).every((key) =>
    identity[key as keyof RestorationIdentity] === parsed.data[key as keyof RestorationIdentity],
  ) && parsed.data.expiryWitnesses.every((w) => w.observedLiveLedger <= snapshot.ledger)) {
    for (const witness of parsed.data.expiryWitnesses) witnesses.set(witness.key, witness);
  }
  const currentKeys = new Set(snapshot.entries.map((e) => e.key));
  for (const key of witnesses.keys()) if (!currentKeys.has(key)) witnesses.delete(key);
  for (const entry of snapshot.entries) {
    if (entry.status === "live" && entry.liveUntilLedger !== null &&
        Number.isSafeInteger(entry.liveUntilLedger) && entry.liveUntilLedger >= snapshot.ledger) {
      witnesses.set(entry.key, {
        key: entry.key, observedLiveLedger: snapshot.ledger, liveUntilLedger: entry.liveUntilLedger,
      });
    }
  }
  const missing = snapshot.entries.filter((e) => e.status !== "live");
  const expiredKeys = missing.filter((entry) => {
    const witness = witnesses.get(entry.key);
    return witness && witness.observedLiveLedger <= witness.liveUntilLedger &&
      snapshot.ledger > witness.liveUntilLedger;
  }).map((e) => e.key);
  return {
    expiryWitnesses: [...witnesses.values()],
    expiredKeys,
    allMissingKeysHaveExpiryWitnesses: missing.length > 0 && missing.length === expiredKeys.length,
  };
}
