import { MierkhatError, rawAmount } from "./amount.js";
import { accountState, quoteExit, type ExitQuote } from "./live.js";
import {
  createExitDraft,
  latestLedger,
  loadDeployment,
  prepareExit,
} from "./rpc.js";
import { assert } from "./policy.js";
import type { DeploymentBundle, ExitDraft, Review } from "./model.js";
import type { rpc } from "@stellar/stellar-sdk";

export function minimumAfterMovement(value: string, bps: number): string {
  assert(
    Number.isInteger(bps) && bps >= 1 && bps <= 500,
    "Movement",
    "input.invalid",
  );
  const result = (rawAmount(value) * BigInt(10000 - bps)) / 10000n;
  return (result > 0n ? result : 1n).toString();
}
export function draftForQuote(
  b: DeploymentBundle,
  owner: string,
  q: ExitQuote,
  bps = 50,
  target?: string,
): ExitDraft {
  const minimum = target ?? minimumAfterMovement(q.receiveRaw, bps);
  rawAmount(minimum);
  assert(
    BigInt(minimum) <= BigInt(q.receiveRaw),
    "TargetUnavailable",
    "plan.unavailable",
  );
  return createExitDraft({
    environment: b.environment,
    epoch: b.epoch,
    intent: {
      schema: 1,
      network_id: b.profile.network_id,
      guard: b.guard,
      profile_hash: b.profileHash,
      owner,
      recipient: owner,
      shares: q.sharesRaw,
      min_withdraw: q.withdrawnRaw.map((v) => minimumAfterMovement(v, bps)),
      min_swap: q.swappedRaw.map((v, n) =>
        b.profile.assets[n]!.asset === b.profile.settlement
          ? "0"
          : minimumAfterMovement(v, bps),
      ),
      min_receive: minimum,
      valid_before_time: (BigInt(q.timestamp) + 240n).toString(),
      valid_before_ledger: q.ledger + 48,
    },
  });
}
export interface WithdrawalReadiness {
  owner: string;
  epoch: string;
  status: "full" | "partial" | "blocked" | "setup" | "empty" | "unknown";
  observedLedger: number;
  observedAt: string;
  checkedAt: string;
  holdingsRaw?: string;
  testedSharesRaw?: string;
  estimatedReceiveRaw?: string;
  minimumReceiveRaw?: string;
  feeMaximumStroops?: string;
  reason: string;
  testedCandidates: number;
  quote?: ExitQuote;
}
function reason(error: unknown): string {
  return error instanceof MierkhatError ? error.code : "ReadUnavailable";
}
export async function withdrawalReadiness(
  b: DeploymentBundle,
  s: rpc.Server,
  owner: string,
  bps = 50,
): Promise<WithdrawalReadiness> {
  assert(!b.migration, "WithdrawalRoute");
  const base: WithdrawalReadiness = {
    owner,
    epoch: b.epoch,
    status: "unknown",
    observedLedger: 0,
    observedAt: "",
    checkedAt: new Date().toISOString(),
    reason: "ReadUnavailable",
    testedCandidates: 0,
  };
  try {
    const account = await accountState(b, s, owner);
    const ledger = await latestLedger(s);
    Object.assign(base, {
      observedLedger: ledger.sequence,
      observedAt: ledger.timestamp,
    });
    if (!account.funded)
      return { ...base, status: "setup", reason: "AccountUnfunded" };
    base.holdingsRaw = account.sharesRaw;
    if (!account.sharesRaw || BigInt(account.sharesRaw) === 0n)
      return { ...base, status: "empty", reason: "NoShares" };
    if (account.tokens.some((t) => !t.trusted))
      return { ...base, status: "setup", reason: "TrustlineRequired" };
    await loadDeployment(b, s, owner);
    let candidate = BigInt(account.sharesRaw);
    for (let n = 0; n < 4 && candidate > 0n; n++, candidate /= 2n) {
      base.testedCandidates++;
      try {
        const q = await quoteExit(b, s, owner, candidate.toString(), true);
        const draft = draftForQuote(b, owner, q, bps);
        const review = await prepareExit(draft, b, s, true);
        return {
          ...base,
          status: n === 0 ? "full" : "partial",
          reason: n === 0 ? "FullFlowTested" : "PartialFlowTested",
          observedLedger: review.preparedLedger,
          observedAt: review.preparedTime,
          testedSharesRaw: candidate.toString(),
          estimatedReceiveRaw: review.expectedReceiveRaw,
          minimumReceiveRaw: draft.intent.min_receive,
          feeMaximumStroops: review.feeMaximumStroops,
          quote: q,
        };
      } catch (e) {
        const code = reason(e);
        base.reason = code;
        // Service/configuration errors are not evidence that funds are inaccessible.
        if (
          !["SimulationRejected", "QuoteAmount", "QuoteRoute", "Zero"].includes(
            code,
          )
        )
          return { ...base, status: "unknown" };
      }
    }
    return { ...base, status: "blocked", reason: "NoCandidateTested" };
  } catch (e) {
    return { ...base, status: "unknown", reason: reason(e) };
  }
}
export interface WithdrawalPlan {
  quote: ExitQuote;
  draft: ExitDraft;
  review: Review;
  targetRaw: string;
  testedCandidates: number;
  holdingsRaw: string;
}
export async function planWithdrawal(
  b: DeploymentBundle,
  s: rpc.Server,
  owner: string,
  targetRaw: string,
  bps = 50,
): Promise<WithdrawalPlan> {
  assert(!b.migration, "WithdrawalRoute");
  rawAmount(targetRaw);
  const account = await accountState(b, s, owner);
  assert(
    account.funded && account.sharesRaw && BigInt(account.sharesRaw) > 0n,
    "NoShares",
    "exit.balance",
  );
  assert(
    account.tokens.every((t) => t.trusted),
    "TrustlineRequired",
    "plan.setup",
  );
  await loadDeployment(b, s, owner);
  const max = BigInt(account.sharesRaw),
    target = BigInt(targetRaw);
  const maxQuote = await quoteExit(b, s, owner, max.toString(), true);
  const maxMinimum = BigInt(minimumAfterMovement(maxQuote.receiveRaw, bps));
  assert(maxMinimum >= target, "TargetUnavailable", "plan.unavailable");
  // A bounded candidate search. No claim of a global minimum or exact-output fill.
  let candidate = (max * target + maxMinimum - 1n) / maxMinimum;
  let last: unknown;
  for (let n = 0; n < 6; n++) {
    if (candidate > max) candidate = max;
    try {
      const q = await quoteExit(b, s, owner, candidate.toString(), true);
      const conservative = BigInt(minimumAfterMovement(q.receiveRaw, bps));
      if (conservative < target) {
        candidate =
          (candidate * target + conservative - 1n) / conservative + 1n;
        continue;
      }
      const draft = draftForQuote(b, owner, q, bps, targetRaw),
        review = await prepareExit(draft, b, s, true);
      return {
        quote: q,
        draft,
        review,
        targetRaw,
        testedCandidates: n + 1,
        holdingsRaw: account.sharesRaw,
      };
    } catch (e) {
      last = e;
      if (
        !(e instanceof MierkhatError) ||
        !["SimulationRejected", "StaleQuote"].includes(e.code)
      )
        throw e;
      if (candidate === max) break;
      candidate = candidate + candidate / 100n + 1n;
    }
  }
  throw last ?? new MierkhatError("TargetUnavailable", "plan.unavailable");
}
export interface MigrationQuote {
  draft: ExitDraft;
  review: Review;
  settlementRaw: string;
  destinationSharesRaw: string;
  depositedRaw: string[];
  refundAssets: string[];
  refundsRaw: string[];
}
export async function quoteMigration(
  b: DeploymentBundle,
  s: rpc.Server,
  owner: string,
  shares: string,
  bps = 50,
): Promise<MigrationQuote> {
  assert(b.migration, "MigrationRoute");
  const account = await accountState(b, s, owner);
  rawAmount(shares);
  assert(
    BigInt(shares) <= BigInt(account.sharesRaw ?? "0"),
    "Balance",
    "exit.balance",
  );
  assert(
    account.tokens.every((t) => t.trusted),
    "TrustlineRequired",
    "plan.setup",
  );
  await loadDeployment(b, s, owner);
  const q = await quoteExit(b, s, owner, shares, true),
    draft = draftForQuote(b, owner, q, bps);
  const legs = b.migration.destination_assets.filter(
    (a) => a.asset !== b.profile.settlement,
  ).length;
  const slots = b.migration.destination_assets.length;
  const budget = BigInt(draft.intent.min_receive);
  let used = 0n;
  const inputs = b.migration.destination_assets.map((a) => {
    if (a.asset === b.profile.settlement) return "0";
    // Direct settlement, if present, retains its proportional part of the budget.
    const amount = budget / BigInt(slots);
    used += amount;
    return amount.toString();
  });
  assert(legs === 0 || used > 0n, "QuoteAmount", "input.positive");
  draft.intent.migration = {
    convert_inputs: inputs,
    min_deposit: b.migration.destination_assets.map(() => "1"),
    min_destination_shares: "1",
  };
  // The initial preflight discovers exact post-withdrawal conversion/deposit effects.
  // Its permissive floors are never returned as the final review conditions.
  const first = await prepareExit(draft, b, s, true);
  assert(first.expectedDestinationSharesRaw, "MigrationQuote");
  // A second full simulation with the user-facing destination-share floor.
  assert(first.migrationEstimate, "MigrationQuote");
  draft.intent.migration.min_deposit = first.migrationEstimate.deposited.map(
    (v) => minimumAfterMovement(v, bps),
  );
  draft.intent.migration.min_destination_shares = minimumAfterMovement(
    first.expectedDestinationSharesRaw,
    bps,
  );
  const review = await prepareExit(draft, b, s, true);
  return {
    draft,
    review,
    settlementRaw: review.expectedReceiveRaw,
    destinationSharesRaw: review.expectedDestinationSharesRaw!,
    depositedRaw: review.migrationEstimate!.deposited,
    refundAssets: review.migrationEstimate!.refundAssets,
    refundsRaw: review.migrationEstimate!.refunds,
  };
}
