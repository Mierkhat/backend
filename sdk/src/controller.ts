import { assert, verifyReview, verifySigned } from "./policy.js";
import type {
  DeploymentBundle,
  ExitDraft,
  Ledger,
  Review,
  SignedAttempt,
  WalletAdapter,
} from "./model.js";
// One unresolved prompt per account even after a view invalidates its result.
const prompts = new Set<string>();
export function reserveWalletPrompt(owner: string): () => void {
  assert(!prompts.has(owner), "PromptOpen", "wallet.prompt");
  prompts.add(owner);
  return () => {
    prompts.delete(owner);
  };
}

export class ExitController {
  private generation = 0;
  private revision = 0;
  private current?: ExitDraft;
  invalidate(): void {
    this.generation++;
    this.current = undefined;
  }
  setDraft(draft: ExitDraft): void {
    this.generation++;
    this.revision = draft.revision;
    this.current = structuredClone(draft);
  }
  async prepare(
    work: (draft: ExitDraft) => Promise<Review>,
  ): Promise<Review | undefined> {
    assert(this.current, "MissingDraft");
    const generation = this.generation;
    const draft = structuredClone(this.current);
    let review: Review;
    try {
      review = await work(draft);
    } catch (error) {
      if (generation !== this.generation) return;
      throw error;
    }
    if (generation !== this.generation || draft.revision !== this.revision)
      return;
    return review;
  }
  async signExit(
    review: Review,
    b: DeploymentBundle,
    wallet: WalletAdapter,
    ledger: () => Promise<Ledger & { sourceSequence: string }>,
    checkDeployment: () => Promise<unknown>,
  ): Promise<SignedAttempt | undefined> {
    assert(this.current, "MissingDraft");
    const generation = this.generation;
    const draft = structuredClone(this.current);
    const identity = await wallet.identity();
    assert(
      identity.address === draft.intent.owner &&
        identity.networkPassphrase === b.networkPassphrase,
      "Identity",
      "wallet.changed",
    );
    await checkDeployment();
    const context = await ledger();
    assert(typeof context.sourceSequence === "string", "MissingSourceSequence");
    verifyReview(review, draft, b, context);
    assert(
      generation === this.generation,
      "PromptInvalidated",
      "wallet.changed",
    );
    const release = reserveWalletPrompt(identity.address);
    try {
      const signed = await wallet.sign(
        review.transactionXdr,
        b.networkPassphrase,
        identity.address,
      );
      const after = await wallet.identity();
      if (
        generation !== this.generation ||
        draft.revision !== this.revision ||
        after.address !== identity.address ||
        after.networkPassphrase !== identity.networkPassphrase
      )
        return;
      return verifySigned(signed, review, b);
    } finally {
      release();
    }
  }
}
export interface PendingPointer {
  environment: string;
  epoch: string;
  hash: string;
  intentHash: string;
  createdAt: string;
}
export function persistPending(
  pointer: PendingPointer,
  storage: Pick<Storage, "getItem" | "setItem">,
): boolean {
  try {
    const key = `mierkhat.pending.${pointer.environment}.${pointer.hash}`;
    storage.setItem(key, JSON.stringify(pointer));
    return storage.getItem(key) !== null;
  } catch {
    return false;
  }
}
