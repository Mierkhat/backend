import { ExitController } from "./controller.js";
import { loadDeployment, reviewLedger } from "./rpc.js";
import type { DeploymentBundle, Review, WalletAdapter } from "./model.js";
import type { rpc } from "@stellar/stellar-sdk";
export async function signExit(
  review: Review,
  bundle: DeploymentBundle,
  wallet: WalletAdapter,
  server: rpc.Server,
  signal?: AbortSignal,
) {
  const controller = new ExitController();
  controller.setDraft(review.draft);
  const abort = () => controller.invalidate();
  if (signal?.aborted) {
    abort();
    return;
  }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await controller.signExit(
      review,
      bundle,
      wallet,
      () => reviewLedger(server, review.draft.intent.owner),
      () => loadDeployment(bundle, server, review.draft.intent.owner),
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
