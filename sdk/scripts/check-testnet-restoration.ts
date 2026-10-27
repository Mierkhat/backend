/** Inspect actual pinned-entry TTLs. Restore only missing entries on explicit
 * --restore, using the dedicated test account and the normal verification policy. */
import { readFile, writeFile, rename } from "node:fs/promises";
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
const evidence: any = {
  checkedAt: new Date().toISOString(),
  network: bundle.networkPassphrase,
  epoch: bundle.epoch,
  guard: bundle.guard,
  before,
  earliestExpiryLedger: live.length ? Math.min(...live) + 1 : null,
  missingCount: missing.length,
  status: missing.length
    ? "archive_verification_required"
    : "waiting_for_actual_entry_expiry",
  archivedToLiveTransitionVerified: false,
  note: "A missing RPC entry alone does not prove archival. TTL cannot be shortened on public testnet. Live entries do not satisfy expired-state acceptance.",
};
const destination = resolve(
  root,
  "contracts/evidence/restoration-readiness.json",
);
async function save() {
  await writeFile(
    destination + ".tmp",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await rename(destination + ".tmp", destination);
}
await save();
if (process.argv.includes("--restore") && missing.length) {
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
  await save();
  await server.sendTransaction(
    new Transaction(bytes, bundle.networkPassphrase),
  );
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = await transactionObservation(server, bundle, signed.hash);
    assert(result.state !== "failed", "RestorationFailed");
    if (result.state === "succeeded") {
      evidence.observation = result;
      evidence.after = await inspect();
      const restored = missing.every((entry) =>
        evidence.after.entries.some(
          (after: any) => after.key === entry.key && after.status === "live",
        ),
      );
      assert(restored, "RestoredEntriesStillMissing");
      await loadDeployment(bundle, server, owner);
      evidence.status = "archived_entries_restored_and_profile_verified";
      evidence.archivedToLiveTransitionVerified = true;
      evidence.immutableDeploymentVerifiedAfterRestore = true;
      await save();
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
