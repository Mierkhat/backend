import { createHash, randomUUID } from "node:crypto";
import {
  quoteExit,
  quoteMigration,
  draftForQuote,
  prepareExit,
  MierkhatError,
  type DeploymentBundle,
} from "@mierkhat/sdk";
import type { Pool } from "pg";
import type { Providers } from "./providers.js";
export interface WatchInput {
  owner: string;
  epoch: string;
  kind: "exit" | "migration";
  sharesRaw: string;
  minimumRaw: string;
  movementBps: number;
}
export interface WatchObservation {
  state: "met" | "unmet" | "unknown";
  checkedAt: string;
  reason: string;
  ledger?: number;
  estimatedRaw?: string;
  minimumRaw?: string;
}
export const capabilityHash = (key: string) =>
  createHash("sha256").update(key).digest("hex");
export class WatchService {
  constructor(
    public pool: Pool,
    private providers: Providers,
    private bundles: DeploymentBundle[],
  ) {}
  async create(input: WatchInput, key: string) {
    const b = this.bundles.find((b) => b.epoch === input.epoch);
    if (!b || !!b.migration !== (input.kind === "migration"))
      throw new MierkhatError("WatchRoute", "route.unsupported");
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO withdrawal_watches(id,capability_hash,owner,epoch,kind,shares_raw,minimum_raw,movement_bps,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,now()+interval '7 days'
      WHERE (SELECT count(*) FROM withdrawal_watches WHERE expires_at>now())<1000 RETURNING id,expires_at`,
      [
        id,
        capabilityHash(key),
        input.owner,
        input.epoch,
        input.kind,
        input.sharesRaw,
        input.minimumRaw,
        input.movementBps,
      ],
    );
    if (!result.rowCount) throw Error("WatchCapacity");
    return { id, expiresAt: result.rows[0].expires_at };
  }
  async read(id: string, key: string) {
    const row = (
      await this.pool.query(
        `SELECT id,owner,epoch,kind,shares_raw,minimum_raw,movement_bps,created_at,expires_at,observation
      FROM withdrawal_watches WHERE id=$1 AND capability_hash=$2 AND expires_at>now()`,
        [id, capabilityHash(key)],
      )
    ).rows[0];
    if (!row) return;
    const notifications = (
      await this.pool.query(
        `SELECT id,observation,created_at,seen_at FROM withdrawal_notifications WHERE watch_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      )
    ).rows;
    return { watch: row, notifications };
  }
  async remove(id: string, key: string) {
    return !!(
      await this.pool.query(
        "DELETE FROM withdrawal_watches WHERE id=$1 AND capability_hash=$2",
        [id, capabilityHash(key)],
      )
    ).rowCount;
  }
  async seen(id: string, key: string, notification: string) {
    return !!(
      await this.pool.query(
        `UPDATE withdrawal_notifications n SET seen_at=COALESCE(seen_at,now()) FROM withdrawal_watches w
      WHERE n.watch_id=w.id AND w.id=$1 AND w.capability_hash=$2 AND n.id=$3`,
        [id, capabilityHash(key), notification],
      )
    ).rowCount;
  }
  async rearm(id: string, key: string) {
    return !!(
      await this.pool.query(
        `UPDATE withdrawal_watches SET last_eligible=false,next_check_at=now()
    WHERE id=$1 AND capability_hash=$2 AND expires_at>now() AND (lease_until IS NULL OR lease_until<now())`,
        [id, capabilityHash(key)],
      )
    ).rowCount;
  }
  async claim() {
    const token = randomUUID();
    return (
      await this.pool.query(
        `UPDATE withdrawal_watches SET lease_token=$1,lease_until=now()+interval '120 seconds'
      WHERE id=(SELECT id FROM withdrawal_watches WHERE expires_at>now() AND next_check_at<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
        [token],
      )
    ).rows[0];
  }
  async record(id: string, lease: string, observation: WatchObservation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          `SELECT * FROM withdrawal_watches WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND expires_at>now() FOR UPDATE`,
          [id, lease],
        )
      ).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }
      const notify = observation.state === "met" && !row.last_eligible;
      const cycle = Number(row.cycle) + (notify ? 1 : 0);
      await client.query(
        `UPDATE withdrawal_watches SET observation=$3,last_eligible=$4,cycle=$5,
        next_check_at=now()+interval '60 seconds',lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2`,
        [
          id,
          lease,
          observation,
          observation.state === "unknown"
            ? row.last_eligible
            : observation.state === "met",
          cycle,
        ],
      );
      if (notify)
        await client.query(
          `INSERT INTO withdrawal_notifications(id,watch_id,cycle,observation) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [randomUUID(), id, cycle, observation],
        );
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async run() {
    const row = await this.claim();
    if (!row) return false;
    let observation: WatchObservation;
    try {
      const b = this.bundles.find((b) => b.epoch === row.epoch);
      if (!b) throw new MierkhatError("WatchRoute", "route.unsupported");
      observation = await this.providers.run(b.environment, async (s) => {
        if (row.kind === "migration") {
          const quote = await quoteMigration(
            b,
            s,
            row.owner,
            row.shares_raw,
            row.movement_bps,
          );
          if (BigInt(quote.destinationSharesRaw) < BigInt(row.minimum_raw))
            return {
              state: "unmet",
              checkedAt: new Date().toISOString(),
              reason: "BelowMinimum",
              ledger: quote.review.preparedLedger,
              estimatedRaw: quote.destinationSharesRaw,
            };
          quote.draft.intent.migration!.min_destination_shares =
            row.minimum_raw;
          const r = await prepareExit(quote.draft, b, s);
          return {
            state: "met",
            checkedAt: new Date().toISOString(),
            reason: "FullFlowTested",
            ledger: r.preparedLedger,
            estimatedRaw: r.expectedDestinationSharesRaw,
            minimumRaw: row.minimum_raw,
          };
        }
        const q = await quoteExit(b, s, row.owner, row.shares_raw);
        if (BigInt(q.receiveRaw) < BigInt(row.minimum_raw))
          return {
            state: "unmet",
            checkedAt: new Date().toISOString(),
            reason: "BelowMinimum",
            ledger: q.ledger,
            estimatedRaw: q.receiveRaw,
          };
        const d = draftForQuote(
          b,
          row.owner,
          q,
          row.movement_bps,
          row.minimum_raw,
        );
        const r = await prepareExit(d, b, s);
        return {
          state: "met",
          checkedAt: new Date().toISOString(),
          reason: "FullFlowTested",
          ledger: r.preparedLedger,
          estimatedRaw: r.expectedReceiveRaw,
          minimumRaw: row.minimum_raw,
        };
      });
    } catch (e) {
      const code = e instanceof MierkhatError ? e.code : "ReadUnavailable";
      observation = {
        state: code === "SimulationRejected" ? "unmet" : "unknown",
        checkedAt: new Date().toISOString(),
        reason: code,
      };
    }
    await this.record(row.id, row.lease_token, observation);
    return true;
  }
  async prune() {
    await this.pool.query(
      "DELETE FROM withdrawal_watches WHERE expires_at<=now()",
    );
  }
}
