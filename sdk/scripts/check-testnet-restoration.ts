/** Inspect actual pinned-entry TTLs. Restore only missing entries on explicit
 * --restore, using the dedicated test account and the normal verification policy. */
import { mkdir, readFile, writeFile, rename, unlink, link } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, Transaction } from "@stellar/stellar-sdk";
import {
  assert,
  bundleSchema,
  loadDeployment,
  prepareSetup,
  restorationKeys,
  rpc,
  signSetup,
  transactionObservation,
  verifySetupSigned,
  type WalletAdapter,
} from "../src/index.js";
import { restorationEvidence, verifyRestorationAttempt } from "../src/restoration-evidence.js";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const bundle = bundleSchema.parse(
  JSON.parse(
    await readFile(
      new URL("../deployments/index.json", import.meta.url),
      "utf8",
    ),
  )[0],
);
assert(bundle.environment === "testnet", "TestnetOnly");
const server = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 12000,
});
assert(
  (await server.getNetwork()).passphrase === bundle.networkPassphrase,
  "NetworkMismatch",
);
const keys = restorationKeys(bundle);
async function inspect() {
  const response = await server.getLedgerEntries(...keys);
  return {
    ledger: response.latestLedger,
    entries: keys.map((key) => {
      const encoded = key.toXDR("base64"),
        found = response.entries.find(
          (entry) => entry.key.toXDR("base64") === encoded,
        );
      return {
        key: encoded,
        kind: key.type,
        status: found ? "live" : "missing_requires_archive_verification",
        liveUntilLedger: found?.liveUntilLedgerSeq ?? null,
      };
    }),
  };
}
const before = await inspect();
const live = before.entries.flatMap((entry) =>
  entry.liveUntilLedger === null ? [] : [entry.liveUntilLedger],
);
const missing = before.entries.filter((entry) => entry.status !== "live");
const destination = resolve(root, ".tooling/testnet/restoration-readiness.json");
await mkdir(resolve(root, ".tooling/testnet"), { recursive: true, mode: 0o700 });
let prior: unknown;
try { prior = JSON.parse(await readFile(destination, "utf8")); } catch {}
const identity = {
  network: bundle.networkPassphrase, epoch: bundle.epoch, guard: bundle.guard,
  guardWasmHash: bundle.guardWasmHash, profileHash: bundle.profileHash,
};
const expiry = restorationEvidence(identity, before, prior);
let evidence: any = {
  checkedAt: new Date().toISOString(),
  network: bundle.networkPassphrase,
  epoch: bundle.epoch,
  guard: bundle.guard,
  guardWasmHash: bundle.guardWasmHash,
  profileHash: bundle.profileHash,
  ...expiry,
  before,
  earliestExpiryLedger: live.length ? Math.min(...live) + 1 : null,
  missingCount: missing.length,
  status: missing.length
    ? "archive_verification_required"
    : "waiting_for_actual_entry_expiry",
  archivedToLiveTransitionVerified: false,
  note: "A missing RPC entry alone does not prove archival. TTL cannot be shortened on public testnet. Live entries do not satisfy expired-state acceptance.",
};
async function save() {
  await writeFile(
    destination + ".tmp",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await rename(destination + ".tmp", destination);
  if (evidence.observation && evidence.restoreHash) {
    const terminal = resolve(root, `.tooling/testnet/restoration-${evidence.restoreHash}-public.json`);
    await writeFile(terminal + ".tmp", JSON.stringify(evidence, null, 2) + "\n");
    await rename(terminal + ".tmp", terminal);
  }
}
const attemptPath = resolve(root, ".tooling/testnet/restoration-attempt.json");
let pending: ReturnType<typeof verifyRestorationAttempt> | undefined;
try {
  pending = verifyRestorationAttempt(JSON.parse(await readFile(attemptPath, "utf8")), bundle);
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}
if (pending) evidence = { ...pending.evidence, resumedAt: new Date().toISOString() };
await save();
if (process.argv.includes("--restore") && (missing.length || pending)) {
 if (!pending) {
  assert(expiry.allMissingKeysHaveExpiryWitnesses, "ArchiveEvidenceRequired");
  const secret = JSON.parse(
    await readFile(resolve(root, ".tooling/testnet/journey-key.json"), "utf8"),
  ).secret;
  const key = Keypair.fromSecret(secret),
    owner = key.publicKey();
  const wallet: WalletAdapter = {
    identity: async () => ({
      address: owner,
      networkPassphrase: bundle.networkPassphrase,
    }),
    sign: async (bytes) => {
      const tx = new Transaction(bytes, bundle.networkPassphrase);
      tx.sign(key);
      return tx.toXDR();
    },
  };
  const draft = {
    kind: "restore" as const,
    owner,
    amountsRaw: [],
    minimumsRaw: [],
    trustAssets: [],
  };
  const review = await prepareSetup(draft, bundle, server),
    bytes = await signSetup(review, bundle, server, wallet);
  const signed = verifySetupSigned(bytes, review, bundle);
  evidence.restoreHash = signed.hash;
  evidence.status = "restoration_submitted_or_unresolved";
  pending = verifyRestorationAttempt({ signedXdr: bytes, hash: signed.hash, review, evidence }, bundle);
  const stagedAttempt = attemptPath + "." + process.pid + ".tmp";
  await writeFile(stagedAttempt, JSON.stringify(pending) + "\n", { mode: 0o600 });
  try {
    // Atomic create, without replacing a concurrent runner's exact attempt.
    await link(stagedAttempt, attemptPath);
  } finally { await unlink(stagedAttempt); }
 }
  await save();
  const initial = await transactionObservation(server, bundle, pending.hash);
  if (initial.state !== "succeeded" && initial.state !== "failed") {
    try {
      await server.sendTransaction(new Transaction(pending.signedXdr, bundle.networkPassphrase));
    } catch { /* Lost admission response: keep the exact private attempt and reconcile its hash. */ }
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = attempt === 0 ? initial : await transactionObservation(server, bundle, pending.hash);
    if (result.state === "failed") {
      evidence.status = "restoration_failed"; evidence.observation = result;
      await save(); await unlink(attemptPath);
      throw Error("RestorationFailed");
    }
    if (result.state === "succeeded") {
      evidence.observation = result;
      evidence.after = await inspect();
      const restored = pending.evidence.before.entries.filter((entry) => entry.status !== "live").every((entry) =>
        evidence.after.entries.some(
          (after: any) => after.key === entry.key && after.status === "live",
        ),
      );
      assert(restored, "RestoredEntriesStillMissing");
      await loadDeployment(bundle, server, pending.review.draft.owner);
      evidence.status = "archived_entries_restored_and_profile_verified";
      evidence.archivedToLiveTransitionVerified = true;
      evidence.immutableDeploymentVerifiedAfterRestore = true;
      await save();
      await unlink(attemptPath);
      break;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert(
    evidence.archivedToLiveTransitionVerified,
    "RestorationStillUnresolved",
  );
}
console.log(
  JSON.stringify({
    status: evidence.status,
    ledger: before.ledger,
    entries: before.entries.length,
    missingCount: missing.length,
    earliestExpiryLedger: evidence.earliestExpiryLedger,
    archivedToLiveTransitionVerified: evidence.archivedToLiveTransitionVerified,
  }),
);
