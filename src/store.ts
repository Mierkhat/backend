import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import type {
  Environment,
  Observation,
  Review,
  SignedAttempt,
} from "@mierkhat/sdk";
export class Conflict extends Error {}
export type AttemptRow = {
  environment: Environment;
  tx_hash: string;
  epoch: string;
  owner: string;
  intent_id: string;
  intent_hash: string;
  signed_envelope_digest: string;
  state: string;
  version: string;
  observation: Observation | null;
  encrypted?: Buffer;
};
export class Store {
  constructor(
    public pool: Pool,
    private key: Buffer,
  ) {
    if (key.length !== 32) throw Error("PAYLOAD_KEY must be 32 bytes");
  }
  private seal(value: string, aad: string): Buffer {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    return Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }
  unseal(value: Buffer, aad: string): string {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([
      decipher.update(value.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8");
  }
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(742813)");
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => n.endsWith(".sql"))
        .sort()) {
        if (
          (
            await client.query(
              "SELECT 1 FROM schema_migrations WHERE version=$1",
              [name],
            )
          ).rowCount
        )
          continue;
        await client.query("BEGIN");
        try {
          await client.query(await readFile(new URL(name, dir), "utf8"));
          await client.query(
            "INSERT INTO schema_migrations(version) VALUES($1)",
            [name],
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(742813)");
      client.release();
    }
  }
  async saveReview(review: Review): Promise<Review> {
    const id = randomUUID(),
      i = review.draft.intent,
      stored = { ...review, reviewId: id };
    await this.pool.query(
      `INSERT INTO reviews(id,environment,epoch,owner,intent_id,revision,intent_hash,envelope_digest,candidate,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10::double precision))`,
      [
        id,
        review.draft.environment,
        review.draft.epoch,
        i.owner,
        i.intent_id,
        review.draft.revision,
        review.intentHash,
        review.envelopeDigest,
        stored,
        i.valid_before_time,
      ],
    );
    return stored;
  }
  async getReview(
    id: string,
    environment: Environment,
  ): Promise<{ review: Review; expired: boolean } | undefined> {
    const r = await this.pool.query(
      "SELECT candidate, expires_at<=now() AS expired FROM reviews WHERE id=$1 AND environment=$2",
      [id, environment],
    );
    return r.rows[0]
      ? { review: r.rows[0].candidate, expired: r.rows[0].expired }
      : undefined;
  }
  async getAttempt(
    environment: Environment,
    hash: string,
  ): Promise<AttemptRow | undefined> {
    return (
      await this.pool.query(
        "SELECT * FROM attempts WHERE environment=$1 AND tx_hash=$2",
        [environment, hash],
      )
    ).rows[0];
  }
  async record(a: SignedAttempt, idempotencyKey: string): Promise<AttemptRow> {
    const client = await this.pool.connect(),
      i = a.review.draft.intent,
      keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO attempts(environment,tx_hash,epoch,signed_envelope_digest,owner,intent_id,intent_hash,review_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          a.environment,
          a.txHash,
          a.epoch,
          a.signedEnvelopeDigest,
          i.owner,
          i.intent_id,
          a.review.intentHash,
          a.review.reviewId,
        ],
      );
      const row = (
        await client.query(
          "SELECT * FROM attempts WHERE environment=$1 AND tx_hash=$2 FOR UPDATE",
          [a.environment, a.txHash],
        )
      ).rows[0] as AttemptRow;
      if (row.signed_envelope_digest !== a.signedEnvelopeDigest)
        throw new Conflict("EnvelopeConflict");
      await client.query(
        "DELETE FROM submission_keys WHERE environment=$1 AND key_hash=$2 AND expires_at<=now()",
        [a.environment, keyHash],
      );
      await client.query(
        "INSERT INTO submission_keys(environment,key_hash,signed_envelope_digest,tx_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [a.environment, keyHash, a.signedEnvelopeDigest, a.txHash],
      );
      const prior = (
        await client.query(
          "SELECT signed_envelope_digest FROM submission_keys WHERE environment=$1 AND key_hash=$2",
          [a.environment, keyHash],
        )
      ).rows[0];
      if (prior.signed_envelope_digest !== a.signedEnvelopeDigest)
        throw new Conflict("IdempotencyConflict");
      if (!["succeeded", "failed"].includes(row.state))
        await client.query(
          "INSERT INTO signed_payloads(environment,tx_hash,encrypted) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [
            a.environment,
            a.txHash,
            this.seal(a.signedXdr, a.environment + ":" + a.txHash),
          ],
        );
      await client.query("COMMIT");
      return row;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async claim(workerId: string): Promise<AttemptRow | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          `SELECT a.*,p.encrypted FROM attempts a LEFT JOIN signed_payloads p ON p.environment=a.environment AND p.tx_hash=a.tx_hash AND p.expires_at>now() LEFT JOIN worker_leases l ON l.environment=a.environment AND l.tx_hash=a.tx_hash WHERE a.state NOT IN ('succeeded','failed') AND a.next_check_at<=now() AND (l.lease_until IS NULL OR l.lease_until<=now()) ORDER BY a.next_check_at FOR UPDATE OF a SKIP LOCKED LIMIT 1`,
        )
      ).rows[0] as AttemptRow | undefined;
      if (row)
        await client.query(
          `INSERT INTO worker_leases(environment,tx_hash,worker_id,lease_until) VALUES($1,$2,$3,now()+interval '30 seconds') ON CONFLICT(environment,tx_hash) DO UPDATE SET worker_id=excluded.worker_id,lease_until=excluded.lease_until`,
          [row.environment, row.tx_hash, workerId],
        );
      await client.query("COMMIT");
      return row;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async renewLease(row: AttemptRow, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE worker_leases l SET lease_until=now()+interval '30 seconds' WHERE l.environment=$1 AND l.tx_hash=$2 AND l.worker_id=$3 AND l.lease_until>now() AND EXISTS(SELECT 1 FROM attempts a WHERE a.environment=$1 AND a.tx_hash=$2 AND a.version=$4 AND a.state NOT IN ('succeeded','failed'))`,
      [row.environment, row.tx_hash, workerId, row.version],
    );
    return !!result.rowCount;
  }
  async update(
    row: AttemptRow,
    observation: Observation,
    workerId?: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // CAS and a lease check prevent delayed workers from downgrading terminal evidence.
      const r = await client.query(
        `UPDATE attempts SET state=$1,observation=$2,version=version+1,updated_at=now(),next_check_at=now()+interval '15 seconds' WHERE environment=$3 AND tx_hash=$4 AND version=$5 AND state NOT IN ('succeeded','failed') AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM worker_leases l WHERE l.environment=$3 AND l.tx_hash=$4 AND l.worker_id=$6 AND l.lease_until>now()))`,
        [
          observation.state,
          observation,
          row.environment,
          row.tx_hash,
          row.version,
          workerId ?? null,
        ],
      );
      if (r.rowCount && ["succeeded", "failed"].includes(observation.state))
        await client.query(
          "DELETE FROM signed_payloads WHERE environment=$1 AND tx_hash=$2",
          [row.environment, row.tx_hash],
        );
      if (workerId)
        await client.query(
          "DELETE FROM worker_leases WHERE environment=$1 AND tx_hash=$2 AND worker_id=$3",
          [row.environment, row.tx_hash, workerId],
        );
      await client.query("COMMIT");
      return !!r.rowCount;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async prune(): Promise<void> {
    await this.pool.query(
      `DELETE FROM signed_payloads WHERE expires_at<=now(); DELETE FROM submission_keys WHERE expires_at<=now(); DELETE FROM reviews WHERE expires_at<now()-interval '24 hours'; DELETE FROM attempts WHERE updated_at<now()-interval '90 days' AND state IN ('succeeded','failed');`,
    );
  }
}
