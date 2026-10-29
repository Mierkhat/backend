import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { inspectSigned, bundleSchema, type SetupReview } from "@mierkhat/sdk";
import { sdkFixture } from "../sdk/src/test-fixture.js";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { SetupService } from "../src/setup.js";
import actualSetup from "../sdk/fixtures/testnet-setup.json" with { type: "json" };
import registry from "../sdk/deployments/index.json" with { type: "json" };
import { WatchService } from "../src/watches.js";
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
    "TRUNCATE withdrawal_watches,reviews,attempts,submission_keys,signed_payloads,worker_leases,setup_jobs CASCADE",
  );
});
function attempt() {
  const f = sdkFixture();
  f.tx.sign(f.key);
  return { f, a: inspectSigned(f.tx.toXDR(), f.bundle) };
}
it("serves real HTTP through the Vercel adapter with persistent database access and closed scheduler authorization", async () => {
  const prior = {
    VERCEL: process.env.VERCEL,
    DATABASE_URL: process.env.DATABASE_URL,
    PAYLOAD_KEY: process.env.PAYLOAD_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
  };
  process.env.VERCEL = "1";
  process.env.DATABASE_URL = `postgresql://postgres:${encodeURIComponent(String(pool.options.password))}@127.0.0.1:${pool.options.port}/postgres`;
  process.env.PAYLOAD_KEY = randomBytes(32).toString("hex");
  delete process.env.CRON_SECRET;
  const { default: handler } = await import(
    new URL("../api/index.js", import.meta.url).href
  );
  const runtime = await import(
    new URL("../dist/server.js", import.meta.url).href
  );
  const server = httpServer((request, response) => {
    void handler(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Missing listener");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(base + "/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: "ready",
      enabledDeployments: 8,
    });
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(base + "/v1/internal/run")).status).toBe(401);
    expect(
      (
        await fetch(base + "/v1/exit/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"owner":"invalid","shares":"25"}',
        })
      ).status,
    ).toBe(400);
    expect((await fetch(base + "/v1/missing")).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.app.close();
    await runtime.pool.end();
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
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
  it("enriches a receipt-less success once without permitting terminal replacement", async () => {
    const { a, f } = attempt();
    await store.record(a, "receipt-enrichment-attempt");
    const pending = (await store.getAttempt(a.environment, a.txHash))!;
    await store.update(pending, {
      hash: a.txHash,
      state: "succeeded",
      ledger: 123,
      observedAt: new Date().toISOString(),
      provider: "horizon-testnet.stellar.org",
    });
    const terminal = (await store.getAttempt(a.environment, a.txHash))!;
    const receipt = {
      intentId: f.draft.intent.intent_id,
      intentHash: a.review.intentHash,
      profileHash: f.bundle.profileHash,
      owner: f.draft.intent.owner,
      sharesSpent: f.draft.intent.shares,
      received: "1",
      withdrawn: ["1", "1"],
      swappedOut: ["1", "1"],
      ledger: 123,
      timestamp: "1",
    };
    const observation = {
      hash: a.txHash,
      state: "succeeded" as const,
      ledger: 123,
      observedAt: new Date().toISOString(),
      receipt,
    };
    expect(await store.enrichReceipt(terminal, observation)).toBe(true);
    expect(await store.enrichReceipt(terminal, observation)).toBe(false);
    const enriched = (await store.getAttempt(a.environment, a.txHash))!;
    expect(enriched.observation?.receipt).toEqual(receipt);
    expect(await store.enrichReceipt(enriched, observation)).toBe(false);
    expect(
      await store.update(enriched, {
        hash: a.txHash,
        state: "unknown",
        observedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    await expect(
      store.enrichReceipt(enriched, {
        ...observation,
        receipt: { ...receipt, owner: f.bundle.guard },
      }),
    ).rejects.toThrow("ReceiptMismatch");
    expect((await pool.query("SELECT 1 FROM signed_payloads")).rowCount).toBe(
      0,
    );
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

describe("route selection boundaries", () => {
  it("rejects an unknown route before contacting providers or preparing anything", async () => {
    const bundle = bundleSchema.parse(registry[0]);
    const app = await createApp({
      store,
      providers: new Providers({}, {}),
      bundles: [bundle],
      origins: [],
    });
    const owner = actualSetup[0]!.review.draft.owner;
    try {
      for (const request of [
        {
          method: "GET" as const,
          url: "/v1/accounts/" + owner + "?epoch=unregistered-route",
        },
        {
          method: "POST" as const,
          url: "/v1/exit/quote",
          payload: { owner, shares: "1", epoch: "unregistered-route" },
        },
        {
          method: "POST" as const,
          url: "/v1/setup/prepare",
          payload: {
            ...actualSetup[0]!.review.draft,
            epoch: "unregistered-route",
          },
        },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(422);
        expect(response.json().code).toBe("UnsupportedDeployment");
      }
      expect((await pool.query("SELECT 1 FROM reviews")).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM setup_jobs")).rowCount).toBe(0);
    } finally {
      await app.close();
    }
  });
  it("verifies a signed setup against its own epoch even when another route is first", async () => {
    const bundles = registry.map((b) => bundleSchema.parse(b)).reverse();
    const providers = new Providers({}, {});
    const service = new SetupService(store, providers, bundles);
    const actual = actualSetup.find((a) => a.review.draft.kind === "deposit")!;
    expect(
      await service.record(actual.signedXdr, actual.review as SetupReview),
    ).toBe(actual.hash);
    const row = (await pool.query("SELECT epoch FROM setup_jobs")).rows[0];
    expect(row.epoch).toBe(actual.review.epoch);
    const altered = structuredClone(actual.review) as SetupReview;
    altered.epoch = "unregistered-route";
    await expect(service.record(actual.signedXdr, altered)).rejects.toThrow(
      "UnsupportedDeployment",
    );
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

describe("durable private withdrawal watches", () => {
  function service() {
    const b = sdkFixture().bundle;
    return { service: new WatchService(pool, new Providers({}, {}), [b]), b };
  }
  it("isolates capability access, persists across instances and deletes observations", async () => {
    const { service: s, b } = service(),
      key = randomBytes(32).toString("hex");
    const { id } = await s.create(
      {
        owner: sdkFixture().draft.intent.owner,
        epoch: b.epoch,
        kind: "exit",
        sharesRaw: "100",
        minimumRaw: "1",
        movementBps: 50,
      },
      key,
    );
    expect(await s.read(id, randomBytes(32).toString("hex"))).toBeUndefined();
    expect((await service().service.read(id, key))?.watch.id).toBe(id);
    const stored = (
      await pool.query(
        "SELECT capability_hash FROM withdrawal_watches WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(stored.capability_hash).not.toBe(key);
    expect(await s.remove(id, randomBytes(32).toString("hex"))).toBe(false);
    expect(await s.remove(id, key)).toBe(true);
    expect(await s.read(id, key)).toBeUndefined();
  });
  it("leases once and emits once per real eligibility transition; unknown does not rearm", async () => {
    const { service: s, b } = service(),
      key = randomBytes(32).toString("hex");
    const { id } = await s.create(
      {
        owner: sdkFixture().draft.intent.owner,
        epoch: b.epoch,
        kind: "exit",
        sharesRaw: "100",
        minimumRaw: "1",
        movementBps: 50,
      },
      key,
    );
    const claims = (
      await Promise.all([s.claim(), service().service.claim()])
    ).filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(
      await s.record(id, randomUUID(), {
        state: "met",
        checkedAt: new Date().toISOString(),
        reason: "FullFlowTested",
      }),
    ).toBe(false);
    const record = async (state: "met" | "unmet" | "unknown") => {
      await pool.query(
        "UPDATE withdrawal_watches SET next_check_at=now(),lease_until=NULL WHERE id=$1",
        [id],
      );
      const row = await s.claim();
      expect(row.id).toBe(id);
      expect(
        await s.record(id, row.lease_token, {
          state,
          checkedAt: new Date().toISOString(),
          reason: state === "unknown" ? "ReadUnavailable" : "FullFlowTested",
        }),
      ).toBe(true);
    };
    await s.record(id, claims[0].lease_token, {
      state: "met",
      checkedAt: new Date().toISOString(),
      reason: "FullFlowTested",
    });
    await record("met");
    await record("unknown");
    await record("met");
    expect((await s.read(id, key))!.notifications).toHaveLength(1);
    await record("unmet");
    await record("met");
    const result = (await s.read(id, key))!;
    expect(result.notifications).toHaveLength(2);
    expect(await s.seen(id, key, result.notifications[0].id)).toBe(true);
    expect((await s.read(id, key))!.notifications[0].seen_at).toBeTruthy();
    expect(await s.remove(id, key)).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM withdrawal_notifications WHERE watch_id=$1",
          [id],
        )
      ).rows[0].count,
    ).toBe("0");
  });
  it("recovers expired leases and excludes expired watches", async () => {
    const { service: s, b } = service(),
      key = randomBytes(32).toString("hex");
    const { id } = await s.create(
      {
        owner: sdkFixture().draft.intent.owner,
        epoch: b.epoch,
        kind: "exit",
        sharesRaw: "100",
        minimumRaw: "1",
        movementBps: 50,
      },
      key,
    );
    const old = await s.claim();
    await pool.query(
      "UPDATE withdrawal_watches SET lease_until=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    const current = await service().service.claim();
    expect(current.lease_token).not.toBe(old.lease_token);
    expect(
      await s.record(id, old.lease_token, {
        state: "met",
        checkedAt: new Date().toISOString(),
        reason: "FullFlowTested",
      }),
    ).toBe(false);
    await pool.query(
      "UPDATE withdrawal_watches SET expires_at=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    expect(await s.read(id, key)).toBeUndefined();
    expect(await s.claim()).toBeUndefined();
    await s.prune();
  });
});
