import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { inspectSigned, bundleSchema, type SetupReview } from "@mierkhat/sdk";
import { sdkFixture } from "../sdk/src/test-fixture.js";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { SetupService } from "../src/setup.js";
import actualSetup from "../sdk/fixtures/testnet-setup.json" with { type: "json" };
import registry from "../sdk/deployments/index.json" with { type: "json" };
import { Providers } from "../src/providers.js";
let postgres: EmbeddedPostgres, pool: Pool, store: Store, directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mierkhat-pg-"));
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const value = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(value));
    });
  });
  const password = randomBytes(24).toString("hex");
  postgres = new EmbeddedPostgres({
    databaseDir: directory,
    port,
    user: "postgres",
    password,
    persistent: false,
    initdbFlags: ["--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
    postgresFlags: ["-h", "127.0.0.1"],
  });
  await postgres.initialise();
  await postgres.start();
  pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password,
    database: "postgres",
    max: 5,
  });
  store = new Store(pool, randomBytes(32));
  await store.migrate();
  await store.migrate();
});
afterAll(async () => {
  await pool?.end();
  await postgres?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE reviews,attempts,submission_keys,signed_payloads,worker_leases,setup_jobs CASCADE",
  );
});
function attempt() {
  const f = sdkFixture();
  f.tx.sign(f.key);
  return { f, a: inspectSigned(f.tx.toXDR(), f.bundle) };
}
describe("R04/R06/R07 durable PostgreSQL tracking", () => {
  it("encrypts exact bytes, survives a new Store, and deduplicates concurrent records", async () => {
    const { a } = attempt();
    const rows = await Promise.all([
      store.record(a, "same-key-for-attempt"),
      store.record(a, "same-key-for-attempt"),
    ]);
    expect(rows[0]!.tx_hash).toBe(rows[1]!.tx_hash);
    const payload = (await pool.query("SELECT encrypted FROM signed_payloads"))
      .rows[0].encrypted;
    expect(payload.toString()).not.toContain(a.signedXdr);
    expect(store.unseal(payload, a.environment + ":" + a.txHash)).toBe(
      a.signedXdr,
    );
    expect(() => store.unseal(payload, a.environment + ":wrong")).toThrow();
    const other = attempt();
    await expect(store.record(other.a, "same-key-for-attempt")).rejects.toThrow(
      "IdempotencyConflict",
    );
    expect(
      (await pool.query("SELECT count(*) FROM attempts")).rows[0].count,
    ).toBe("1");
  });
  it("rejects replacement signature bytes at the same transaction hash", async () => {
    const { a, f } = attempt();
    await store.record(a, "attempt-key-000001");
    f.tx.sign(f.key);
    const changed = {
      ...a,
      signedEnvelopeDigest: "ab".repeat(32),
      signedXdr: f.tx.toXDR(),
    };
    await expect(store.record(changed, "attempt-key-000002")).rejects.toThrow(
      "EnvelopeConflict",
    );
  });
  it("claims one lease, recovers expiry, and preserves terminal CAS", async () => {
    const { a } = attempt();
    await store.record(a, "attempt-key-000003");
    const worker = randomUUID();
    const [one, two] = await Promise.all([
      store.claim(worker),
      store.claim(randomUUID()),
    ]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const row = one ?? two!;
    const owner = (await pool.query("SELECT worker_id FROM worker_leases"))
      .rows[0].worker_id;
    expect(
      await store.update(
        row,
        {
          hash: a.txHash,
          state: "succeeded",
          ledger: 123,
          observedAt: new Date().toISOString(),
        },
        owner,
      ),
    ).toBe(true);
    expect(
      await store.update(row, {
        hash: a.txHash,
        state: "unknown",
        observedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect((await store.getAttempt(a.environment, a.txHash))!.state).toBe(
      "succeeded",
    );
    expect(
      (await pool.query("SELECT count(*) FROM signed_payloads")).rows[0].count,
    ).toBe("0");
  });
  it("records before send and resumes after a crashed lease", async () => {
    const { a } = attempt();
    await store.record(a, "attempt-key-000004");
    const initial = await store.claim(randomUUID());
    expect(initial?.encrypted).toBeTruthy();
    await pool.query(
      "UPDATE worker_leases SET lease_until=now()-interval '1 second'",
    );
    const recovered = await store.claim(randomUUID());
    expect(recovered?.tx_hash).toBe(a.txHash);
    expect(
      store.unseal(recovered!.encrypted!, a.environment + ":" + a.txHash),
    ).toBe(a.signedXdr);
  });
  it("never exposes expired encrypted payloads to a recovery worker", async () => {
    const { a } = attempt();
    await store.record(a, "attempt-key-expired-0001");
    await pool.query(
      "UPDATE signed_payloads SET expires_at=now()-interval '1 second'",
    );
    const row = await store.claim(randomUUID());
    expect(row?.tx_hash).toBe(a.txHash);
    expect(row?.encrypted).toBeNull();
  });
  it("renews only the current live lease and never revives an expired owner", async () => {
    const { a } = attempt();
    await store.record(a, "renew-lease-attempt-0001");
    const worker = randomUUID();
    const row = (await store.claim(worker))!;
    expect(await store.renewLease(row, randomUUID())).toBe(false);
    expect(await store.renewLease(row, worker)).toBe(true);
    await pool.query(
      "UPDATE worker_leases SET lease_until=now()-interval '1 second'",
    );
    expect(await store.renewLease(row, worker)).toBe(false);
  });
  it("persists unsigned reviews and handles expired/wrong-environment lookup", async () => {
    const { f } = attempt();
    const saved = await store.saveReview(f.review);
    expect((await store.getReview(saved.reviewId!, "testnet"))?.expired).toBe(
      true,
    );
    expect(await store.getReview(saved.reviewId!, "local")).toBeUndefined();
  });
  it("API returns tracking acceptance without claiming a ledger result", async () => {
    const { a, f } = attempt();
    const app = await createApp({
      store,
      providers: new Providers({}, {}),
      bundles: [f.bundle],
      origins: ["http://localhost:5173"],
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/exit/submit",
        headers: { "idempotency-key": "http-attempt-key-0001" },
        payload: {
          environment: a.environment,
          epoch: a.epoch,
          signedXdr: a.signedXdr,
          claimedHash: a.txHash,
          reviewId: null,
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().state).toBe("recorded");
      expect(await store.getAttempt("testnet", a.txHash)).toBeTruthy();
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/exit/submit",
        payload: { signedXdr: "bad" },
      });
      expect(invalid.statusCode).toBe(400);
      const malformed = await app.inject({
        method: "POST",
        url: "/v1/exit/submit",
        headers: { "content-type": "application/json" },
        payload: "{broken",
      });
      expect(malformed.statusCode).toBe(400);
      const large = await app.inject({
        method: "POST",
        url: "/v1/exit/submit",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ data: "x".repeat(262144) }),
      });
      expect(large.statusCode).toBe(413);

      expect(invalid.body).not.toContain("stack");
    } finally {
      await app.close();
    }
  });
});

describe("real PostgreSQL setup job durability", () => {
  it("commits encrypted exact setup bytes before submission and deduplicates concurrent records", async () => {
    const bundle = bundleSchema.parse(registry[0]),
      providers = new Providers(
        { testnet: ["https://soroban-testnet.stellar.org"] },
        { testnet: bundle.networkPassphrase },
      ),
      service = new SetupService(store, providers, bundle),
      a = actualSetup.find((a) => a.review.draft.kind === "deposit")!;
    const hashes = await Promise.all([
      service.record(a.signedXdr, a.review as SetupReview),
      service.record(a.signedXdr, a.review as SetupReview),
    ]);
    expect(hashes).toEqual([a.hash, a.hash]);
    const rows = (await pool.query("SELECT * FROM setup_jobs")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("recorded");
    expect(rows[0].encrypted.toString()).not.toContain(a.signedXdr);
    expect(store.unseal(rows[0].encrypted, "setup:" + a.hash)).toBe(
      a.signedXdr,
    );
    expect(() =>
      store.unseal(rows[0].encrypted, "setup:" + "00".repeat(32)),
    ).toThrow();
  });
  it("refuses a mutated setup job before any durable write", async () => {
    const bundle = bundleSchema.parse(registry[0]),
      providers = new Providers(
        { testnet: [] },
        { testnet: bundle.networkPassphrase },
      ),
      service = new SetupService(store, providers, bundle),
      a = structuredClone(
        actualSetup.find((a) => a.review.draft.kind === "deposit")!,
      );
    a.review.draft.amountsRaw[0] = "1";
    await expect(
      service.record(a.signedXdr, a.review as SetupReview),
    ).rejects.toThrow();
    expect((await pool.query("SELECT 1 FROM setup_jobs")).rowCount).toBe(0);
  });
});
