import { randomUUID } from "node:crypto";
import {
  decodeEnvelope,
  decodeReceipt,
  validateIntent,
  type DeploymentBundle,
  type Observation,
} from "@mierkhat/sdk";
import type { Store } from "./store.js";
import type { Providers } from "./providers.js";
export async function reconcileOne(
  store: Store,
  providers: Providers,
  bundles: DeploymentBundle[],
  workerId = randomUUID(),
): Promise<boolean> {
  const row = await store.claim(workerId);
  if (!row) return false;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void store
      .renewLease(row, workerId)
      .catch(() => false)
      .finally(() => {
        renewing = false;
      });
  }, 10000);
  const bundle = bundles.find(
    (b) => b.environment === row.environment && b.epoch === row.epoch,
  );
  let observation: Observation = {
    state: "unknown",
    hash: row.tx_hash,
    observedAt: new Date().toISOString(),
  };
  try {
    if (bundle)
      observation = await providers.run(row.environment, async (server) => {
        const found = await decodeReceipt(server, bundle, row.tx_hash);
        if (
          found.state === "succeeded" ||
          found.state === "failed" ||
          found.rawStatus === "SUCCESS_AWAITING_RECEIPT"
        )
          return found;
        if (row.encrypted && bundle.enabled && bundle.reviewed) {
          const bytes = store.unseal(
            row.encrypted,
            row.environment + ":" + row.tx_hash,
          );
          const tx = decodeEnvelope(bytes, bundle.networkPassphrase);
          const l = await server.getLatestLedger();
          // R07/R08: lookup precedes an exact resend, and expired attempts remain unknown.
          if (
            tx.timeBounds &&
            BigInt(tx.timeBounds.maxTime) >= BigInt(l.closeTime) &&
            tx.ledgerBounds &&
            tx.ledgerBounds.maxLedger > l.sequence
          ) {
            const sent = await server.sendTransaction(tx);
            return {
              ...found,
              state:
                sent.status === "PENDING" || sent.status === "DUPLICATE"
                  ? "pending"
                  : "unknown",
              rawStatus: sent.status,
            };
          }
        }
        return found;
      });
  } catch {
    /* Unavailability is an observation, never confirmed failure. */
  }
  clearInterval(heartbeat);
  await store.update(row, observation, workerId);
  return true;
}
