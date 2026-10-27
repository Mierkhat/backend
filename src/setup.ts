import {
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  accountState,
  assert,
  decodeEnvelope,
  digest,
  hex,
  stellarAssets,
  transactionObservation,
  verifySetupSigned,
  type DeploymentBundle,
  type Observation,
  type SetupReview,
} from "@mierkhat/sdk";
import type { Store } from "./store.js";
import type { Providers } from "./providers.js";
import { Conflict } from "./store.js";
export class SetupService {
  constructor(
    private store: Store,
    private providers: Providers,
    private bundle: DeploymentBundle,
    private issuer?: Keypair,
  ) {}
  async record(bytes: string, review: SetupReview): Promise<string> {
    const { hash, digest: signedDigest } = verifySetupSigned(
      bytes,
      review,
      this.bundle,
    );
    const inserted = await this.store.pool.query(
      `INSERT INTO setup_jobs(tx_hash,owner,kind,epoch,signed_digest,encrypted,review) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        hash,
        review.draft.owner,
        review.draft.kind,
        this.bundle.epoch,
        signedDigest,
        this.store.seal(bytes, "setup:" + hash),
        review,
      ],
    );
    if (!inserted.rowCount) {
      const row = (
        await this.store.pool.query(
          "SELECT signed_digest FROM setup_jobs WHERE tx_hash=$1",
          [hash],
        )
      ).rows[0];
      if (row.signed_digest !== signedDigest)
        throw new Conflict("EnvelopeConflict");
    }
    return hash;
  }
  async faucet(
    owner: string,
  ): Promise<{ hash: string; amounts: { symbol: string; amount: string }[] }> {
    assert(
      this.issuer && this.bundle.environment === "testnet",
      "FaucetUnavailable",
      "faucet.unavailable",
    );
    const c = await this.store.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(742815)");
      const previous = (
        await c.query(
          `SELECT tx_hash FROM setup_jobs WHERE kind='faucet' AND owner=$1 AND created_at>now()-interval '24 hours' AND state<>'failed' ORDER BY created_at DESC LIMIT 1`,
          [owner],
        )
      ).rows[0];
      if (previous)
        return {
          hash: previous.tx_hash,
          amounts: this.bundle.tokens.map((t) => ({
            symbol: t.symbol,
            amount: "1000",
          })),
        };
      const unresolved = await c.query(
        `SELECT 1 FROM setup_jobs WHERE kind='faucet' AND state NOT IN ('succeeded','failed') AND created_at>now()-interval '5 minutes' LIMIT 1`,
      );
      assert(!unresolved.rowCount, "FaucetBusy", "faucet.busy");
      const daily = await c.query(
        `SELECT count(*)::int AS n FROM setup_jobs WHERE kind='faucet' AND created_at>now()-interval '24 hours'`,
      );
      assert(daily.rows[0].n < 100, "FaucetLimit", "faucet.limit");
      const bytes = await this.providers.run("testnet", async (s) => {
        const a = await accountState(this.bundle, s, owner);
        assert(
          a.funded && a.tokens.every((t) => t.trusted),
          "TrustRequired",
          "setup.trust_required",
        );
        const tx = new TransactionBuilder(
          await s.getAccount(this.issuer!.publicKey()),
          { fee: "3000", networkPassphrase: this.bundle.networkPassphrase },
        ).setTimeout(180);
        for (const asset of stellarAssets(this.bundle)) {
          assert(asset.issuer === this.issuer!.publicKey(), "FaucetIssuer");
          tx.addOperation(
            Operation.payment({ destination: owner, asset, amount: "1000" }),
          );
        }
        const built = tx.build();
        built.sign(this.issuer!);
        return built.toXDR();
      });
      const tx = decodeEnvelope(bytes, this.bundle.networkPassphrase),
        hash = hex(tx.hash());
      await c.query(
        `INSERT INTO setup_jobs(tx_hash,owner,kind,epoch,signed_digest,encrypted) VALUES($1,$2,'faucet',$3,$4,$5)`,
        [
          hash,
          owner,
          this.bundle.epoch,
          digest(tx.toEnvelope().toXDR()),
          this.store.seal(bytes, "setup:" + hash),
        ],
      );
      return {
        hash,
        amounts: this.bundle.tokens.map((t) => ({
          symbol: t.symbol,
          amount: "1000",
        })),
      };
    } finally {
      await c.query("SELECT pg_advisory_unlock(742815)");
      c.release();
    }
  }
  async status(hash: string): Promise<Observation> {
    const row = (
      await this.store.pool.query(
        "SELECT observation,state FROM setup_jobs WHERE tx_hash=$1",
        [hash],
      )
    ).rows[0];
    if (
      row?.observation &&
      (row.state === "succeeded" || row.state === "failed")
    )
      return row.observation;
    return this.providers.run("testnet", (s) =>
      transactionObservation(s, this.bundle, hash),
    );
  }
  async reconcile(): Promise<void> {
    const c = await this.store.pool.connect();
    let locked = false;
    try {
      locked = (await c.query("SELECT pg_try_advisory_lock(742816) AS locked"))
        .rows[0].locked;
      if (!locked) return;
      const row = (
        await c.query(
          `SELECT * FROM setup_jobs WHERE state NOT IN ('succeeded','failed') AND next_check_at<=now() ORDER BY next_check_at LIMIT 1`,
        )
      ).rows[0];
      if (!row) return;
      let observation: Observation = {
        hash: row.tx_hash,
        state: "unknown",
        observedAt: new Date().toISOString(),
      };
      try {
        observation = await this.providers.run("testnet", async (s) => {
          const found = await transactionObservation(
            s,
            this.bundle,
            row.tx_hash,
          );
          if (found.state === "succeeded" || found.state === "failed")
            return found;
          if (row.encrypted) {
            const tx = decodeEnvelope(
                this.store.unseal(row.encrypted, "setup:" + row.tx_hash),
                this.bundle.networkPassphrase,
              ),
              l = await s.getLatestLedger();
            if (
              tx.timeBounds &&
              BigInt(tx.timeBounds.maxTime) > BigInt(l.closeTime) &&
              (!tx.ledgerBounds || tx.ledgerBounds.maxLedger > l.sequence)
            ) {
              const result = await s.sendTransaction(tx);
              return {
                ...found,
                state:
                  result.status === "PENDING" || result.status === "DUPLICATE"
                    ? ("pending" as const)
                    : ("unknown" as const),
                rawStatus: result.status,
              };
            }
          }
          return found;
        });
      } catch {}
      await c.query(
        `UPDATE setup_jobs SET state=$1,observation=$2,updated_at=now(),next_check_at=now()+CASE WHEN created_at<now()-interval '1 hour' THEN interval '5 minutes' ELSE interval '4 seconds' END,encrypted=CASE WHEN $1 IN ('succeeded','failed') OR created_at<now()-interval '24 hours' THEN NULL ELSE encrypted END WHERE tx_hash=$3 AND state NOT IN ('succeeded','failed')`,
        [observation.state, observation, row.tx_hash],
      );
    } finally {
      if (locked) await c.query("SELECT pg_advisory_unlock(742816)");
      c.release();
    }
  }
}
