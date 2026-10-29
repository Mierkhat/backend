import Fastify from "fastify";
import { exitToolPaths, registerExitTools } from "./tools.js";
import { WatchService } from "./watches.js";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import {
  MierkhatError,
  accountState,
  accountPositions,
  networkState,
  quoteExit,
  prepareSetup,
  verifySetupSigned,
  amountSchema,
  accountSchema,
  assert,
  decodeReceipt,
  decodeKnownReceipt,
  environmentSchema,
  hashSchema,
  inspectSigned,
  intentSchema,
  intentHash,
  latestLedger,
  loadDeployment,
  prepareExit,
  validateBundle,
  verifyReview,
  type DeploymentBundle,
  type ExitDraft,
} from "@mierkhat/sdk";
import { Conflict, type Store } from "./store.js";
import type { SetupService } from "./setup.js";
import type { Providers } from "./providers.js";
const domain = z
  .object({ environment: environmentSchema, epoch: z.string().min(1).max(80) })
  .strict();
const prepareBody = domain
  .extend({ revision: z.number().int().positive(), intent: intentSchema })
  .strict();
const submitBody = domain
  .extend({
    signedXdr: z.string().min(1).max(349528),
    claimedHash: hashSchema,
    reviewId: z.uuid().nullable(),
  })
  .strict();
const query = z.object({ environment: environmentSchema }).strict();
const setupDraft = z
  .object({
    kind: z.enum(["trustlines", "deposit", "restore"]),
    owner: accountSchema,
    amountsRaw: z.array(amountSchema).max(2),
    minimumsRaw: z.array(amountSchema).max(2),
    trustAssets: z.array(z.string().max(56)).max(4),
  })
  .strict();
const setupReviewSchema = z
  .object({
    draft: setupDraft,
    environment: z.literal("testnet"),
    epoch: z.string().max(80),
    transactionXdr: z.string().max(349528),
    envelopeDigest: hashSchema,
    authDigest: hashSchema,
    preparedLedger: z.number().int().positive(),
    preparedTime: amountSchema,
    expectedDepositedRaw: z.array(amountSchema).max(2),
    expectedSharesRaw: amountSchema,
    feeMaximumStroops: amountSchema,
  })
  .strict();
const setupSubmitSchema = z
  .object({ signedXdr: z.string().max(349528), review: setupReviewSchema })
  .strict();
const ownerBody = z.object({ owner: accountSchema }).strict();
const routeEpoch = z.string().min(1).max(80).optional();
const setupPrepareBody = setupDraft.extend({ epoch: routeEpoch });
const quoteBody = z
  .object({ owner: accountSchema, shares: amountSchema, epoch: routeEpoch })
  .strict();
const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema: z.toJSONSchema(schema) } },
});
export async function createApp(options: {
  store: Store;
  providers: Providers;
  bundles: DeploymentBundle[];
  origins: string[];
  setup?: SetupService;
  trustProxy?: boolean;
}) {
  const { store, providers } = options;
  const knownBundles = options.bundles.map((b) => validateBundle(b, "read"));
  const bundles = knownBundles
    .filter((b) => b.enabled)
    .map((b) => validateBundle(b));
  const app = Fastify({
    bodyLimit: 262144,
    logger: false,
    requestTimeout: 15000,
    trustProxy: options.trustProxy ?? false,
  });
  await app.register(cors, {
    origin: options.origins,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Idempotency-Key", "X-Watch-Key"],
  });
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Robots-Tag", "noindex, nofollow");
  });
  app.setErrorHandler((error, req, reply) => {
    const clientStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : undefined;
    const status =
      error instanceof Conflict
        ? 409
        : error instanceof z.ZodError
          ? 400
          : error instanceof MierkhatError
            ? 422
            : (clientStatus ?? 503);
    reply.code(status).send({
      code:
        error instanceof MierkhatError
          ? error.code
          : status === 409
            ? "Conflict"
            : status >= 400 && status < 500 && status !== 429
              ? "InvalidRequest"
              : status === 429
                ? "RateLimited"
                : "Unavailable",
      copyKey:
        error instanceof MierkhatError
          ? error.copyKey
          : status >= 400 && status < 500 && status !== 429
            ? "input.invalid"
            : "service.unavailable",
      retryable: status >= 500 || status === 429,
      requestId: req.id,
    });
  });
  const bundle = (environment: string, epoch?: string, forRead = false) => {
    const b = (forRead ? knownBundles : bundles).find(
      (v) => v.environment === environment && (!epoch || v.epoch === epoch),
    );
    if (!b)
      throw new MierkhatError("UnsupportedDeployment", "route.unsupported");
    return b;
  };
  app.get("/v1/openapi.json", async () => ({
    openapi: "3.1.0",
    info: { title: "Mierkhat API", version: "0.1.0" },
    paths: {
      ...exitToolPaths(),
      "/v1/network": {
        get: {
          responses: {
            "200": {
              description: "Current verified testnet ledger and vault totals",
            },
          },
        },
      },
      "/v1/accounts/{owner}": {
        get: {
          parameters: [
            {
              in: "path",
              name: "owner",
              required: true,
              schema: z.toJSONSchema(accountSchema),
            },
          ],
          responses: {
            "200": {
              description:
                "Actual account funding, trustline, asset and selected vault share state (optional epoch query)",
            },
          },
        },
      },
      "/v1/accounts/{owner}/positions": {
        get: {
          parameters: [
            {
              in: "path",
              name: "owner",
              required: true,
              schema: z.toJSONSchema(accountSchema),
            },
          ],
          responses: {
            "200": {
              description:
                "Actual positive share balances, grouped once per supported vault with its pinned output routes",
            },
          },
        },
      },
      "/v1/exit/quote": {
        post: {
          requestBody: jsonBody(quoteBody),
          responses: {
            "200": {
              description:
                "Current on-chain withdrawal and direct conversion quote",
            },
          },
        },
      },
      "/v1/setup/prepare": {
        post: {
          requestBody: jsonBody(setupPrepareBody),
          responses: {
            "200": {
              description:
                "Unsigned trustline, deposit or explicit restoration review requiring independent verification",
            },
          },
        },
      },
      "/v1/setup/submit": {
        post: {
          requestBody: jsonBody(setupSubmitSchema),
          responses: {
            "202": {
              description:
                "Exact verified signed bytes durably recorded before send",
            },
          },
        },
      },
      "/v1/testnet/fund": {
        post: {
          requestBody: jsonBody(ownerBody),
          responses: {
            "200": { description: "Actual funded testnet account state" },
          },
        },
      },
      "/v1/testnet/faucet": {
        post: {
          requestBody: jsonBody(ownerBody.extend({ epoch: routeEpoch })),
          responses: {
            "202": {
              description:
                "Durably recorded actual token issuance hash and allocation",
            },
          },
        },
      },
      "/v1/setup/transactions/{hash}": {
        get: {
          parameters: [
            {
              in: "path",
              name: "hash",
              required: true,
              schema: z.toJSONSchema(hashSchema),
            },
          ],
          responses: {
            "200": {
              description:
                "Committed transaction observation or explicit unknown",
            },
          },
        },
      },

      "/v1/exit/prepare": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: z.toJSONSchema(prepareBody) },
            },
          },
          responses: {
            "200": {
              description:
                "Unsigned candidate requiring independent SDK verification",
            },
          },
        },
      },
      "/v1/exit/submit": {
        post: {
          parameters: [
            {
              in: "header",
              name: "Idempotency-Key",
              required: true,
              schema: { type: "string", minLength: 16, maxLength: 200 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: z.toJSONSchema(submitBody) },
            },
          },
          responses: {
            "202": {
              description: "Recorded for tracking, not a ledger result",
            },
          },
        },
      },
      "/v1/environments": {
        get: {
          responses: { "200": { description: "Enabled pinned deployments" } },
        },
      },
      "/v1/profiles/{profileHash}": {
        get: {
          parameters: [
            {
              in: "path",
              name: "profileHash",
              required: true,
              schema: z.toJSONSchema(hashSchema),
            },
            {
              in: "query",
              name: "environment",
              required: true,
              schema: z.toJSONSchema(environmentSchema),
            },
          ],
          responses: {
            "200": { description: "Immutable public deployment metadata" },
            "404": { description: "No supported profile" },
          },
        },
      },
      "/v1/reviews/{reviewId}": {
        get: {
          parameters: [
            {
              in: "path",
              name: "reviewId",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              in: "query",
              name: "environment",
              required: true,
              schema: z.toJSONSchema(environmentSchema),
            },
          ],
          responses: {
            "200": { description: "Unsigned candidate" },
            "404": { description: "Unknown or wrong environment" },
            "410": { description: "Expired review" },
          },
        },
      },
      "/v1/transactions/{hash}": {
        get: {
          parameters: [
            {
              in: "path",
              name: "hash",
              required: true,
              schema: z.toJSONSchema(hashSchema),
            },
            {
              in: "query",
              name: "environment",
              required: true,
              schema: z.toJSONSchema(environmentSchema),
            },
          ],
          responses: {
            "200": {
              description:
                "Hash observation with verified receipt when available",
            },
          },
        },
      },
      "/v1/health": {
        get: {
          responses: {
            "200": { description: "Ready" },
            "503": { description: "Database unavailable" },
          },
        },
      },
    },
  }));
  app.get("/v1/health", async (_req, reply) => {
    try {
      await store.pool.query("SELECT 1");
      return { status: "ready", enabledDeployments: bundles.length };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/v1/environments", async () => bundles);
  const testnet = () => bundle("testnet");
  let networkCache:
    | { at: number; value: Awaited<ReturnType<typeof networkState>> }
    | undefined;
  app.get("/v1/network", async () => {
    if (networkCache && Date.now() - networkCache.at < 10000)
      return networkCache.value;
    const value = await providers.run("testnet", (s) =>
      networkState(testnet(), s),
    );
    networkCache = { at: Date.now(), value };
    return value;
  });
  app.get("/v1/accounts/:owner", async (req) => {
    const { owner } = z.object({ owner: accountSchema }).parse(req.params);
    const { epoch } = z
      .object({ epoch: z.string().min(1).max(80).optional() })
      .strict()
      .parse(req.query);
    const selected = bundle("testnet", epoch);
    return providers.run("testnet", (s) => accountState(selected, s, owner));
  });
  app.get("/v1/accounts/:owner/positions", async (req) => {
    const { owner } = z.object({ owner: accountSchema }).parse(req.params);
    return providers.run("testnet", (s) =>
      accountPositions(
        bundles.filter((b) => b.environment === "testnet"),
        s,
        owner,
      ),
    );
  });
  app.post(
    "/v1/exit/quote",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const body = quoteBody.parse(req.body);
      const selected = bundle("testnet", body.epoch);
      return providers.run("testnet", (s) =>
        quoteExit(selected, s, body.owner, body.shares),
      );
    },
  );
  app.post(
    "/v1/setup/prepare",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req) => {
      const { epoch, ...d } = setupPrepareBody.parse(req.body);
      const selected = bundle("testnet", epoch);
      return providers.run("testnet", (s) => prepareSetup(d, selected, s));
    },
  );
  app.post("/v1/setup/submit", async (req, reply) => {
    assert(options.setup, "SetupUnavailable");
    const body = setupSubmitSchema.parse(req.body);
    const hash = await options.setup.record(body.signedXdr, body.review);
    return reply.code(202).send({ hash, state: "recorded" });
  });
  app.post(
    "/v1/testnet/faucet",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      assert(options.setup, "SetupUnavailable");
      const { owner, epoch } = z
        .object({ owner: accountSchema, epoch: routeEpoch })
        .strict()
        .parse(req.body);
      return reply.code(202).send(await options.setup.faucet(owner, epoch));
    },
  );
  app.post(
    "/v1/testnet/fund",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (req) => {
      const { owner } = z
        .object({ owner: accountSchema })
        .strict()
        .parse(req.body);
      const a = await providers.run("testnet", (s) =>
        accountState(testnet(), s, owner),
      );
      if (!a.funded) {
        const response = await fetch(
          "https://friendbot.stellar.org/?addr=" + encodeURIComponent(owner),
          { signal: AbortSignal.timeout(20000) },
        );
        assert(response.ok, "Friendbot", "funding.unavailable");
      }
      return providers.run("testnet", (s) => accountState(testnet(), s, owner));
    },
  );
  app.get("/v1/setup/transactions/:hash", async (req) => {
    assert(options.setup, "SetupUnavailable");
    const { hash } = z.object({ hash: hashSchema }).parse(req.params);
    return options.setup.status(hash);
  });

  app.get("/v1/profiles/:profileHash", async (req, reply) => {
    const q = query.parse(req.query);
    const p = z.object({ profileHash: hashSchema }).parse(req.params);
    const found = bundles.find(
      (b) => b.environment === q.environment && b.profileHash === p.profileHash,
    );
    if (!found)
      return reply
        .code(404)
        .send({ code: "NotFound", copyKey: "route.unsupported" });
    return found;
  });
  app.post(
    "/v1/exit/prepare",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req) => {
      const body = prepareBody.parse(req.body),
        b = bundle(body.environment, body.epoch);
      const draft: ExitDraft = {
        intent: body.intent,
        revision: body.revision,
        environment: body.environment,
        epoch: body.epoch,
      };
      const review = await providers.run(body.environment, (server) =>
        prepareExit(draft, b, server),
      );
      return store.saveReview(review);
    },
  );
  app.get("/v1/reviews/:reviewId", async (req, reply) => {
    const q = query.parse(req.query);
    const p = z.object({ reviewId: z.uuid() }).parse(req.params);
    const found = await store.getReview(p.reviewId, q.environment);
    if (!found)
      return reply
        .code(404)
        .send({ code: "ReviewMissing", copyKey: "review.missing" });
    if (found.expired)
      return reply
        .code(410)
        .send({ code: "ReviewExpired", copyKey: "review.expired" });
    return found.review;
  });
  app.post(
    "/v1/exit/submit",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = submitBody.parse(req.body),
        b = bundle(body.environment, body.epoch);
      const idempotencyKey = z
        .string()
        .min(16)
        .max(200)
        .parse(req.headers["idempotency-key"]);
      const a = inspectSigned(body.signedXdr, b, body.reviewId);
      assert(a.txHash === body.claimedHash, "HashMismatch");
      if (body.reviewId) {
        const found = await store.getReview(body.reviewId, body.environment);
        assert(
          found &&
            found.review.intentHash === a.review.intentHash &&
            found.review.envelopeDigest === a.review.envelopeDigest,
          "ReviewMismatch",
        );
        a.review = found.review;
      }
      // Record is committed BEFORE any submit. Workers recover a process death at this boundary.
      await store.record(a, idempotencyKey);
      return reply.code(202).send({
        hash: a.txHash,
        state: "recorded",
        statusUrl: `/v1/transactions/${a.txHash}?environment=${body.environment}`,
      });
    },
  );
  app.get("/v1/transactions/:hash", async (req, reply) => {
    const q = query.parse(req.query);
    const p = z.object({ hash: hashSchema }).parse(req.params);
    const setupRow = await store.pool.query(
      "SELECT 1 FROM setup_jobs WHERE tx_hash=$1",
      [p.hash],
    );
    if (setupRow.rowCount && options.setup) return options.setup.status(p.hash);
    const row = await store.getAttempt(q.environment, p.hash);
    if (
      row?.state === "failed" ||
      (row?.state === "succeeded" && row.observation?.receipt)
    )
      return row.observation;
    const b = bundle(q.environment, row?.epoch, true);
    try {
      const observation = await providers.run(q.environment, (server) =>
        row
          ? decodeReceipt(server, b, p.hash)
          : decodeKnownReceipt(
              server,
              knownBundles.filter(
                (candidate) => candidate.environment === q.environment,
              ),
              p.hash,
            ),
      );
      if (row?.state === "succeeded") {
        if (observation.state === "succeeded" && observation.receipt) {
          await store.enrichReceipt(row, observation);
          return observation;
        }
        return row.observation;
      }
      if (row) await store.update(row, observation);
      return observation;
    } catch (error) {
      if (row?.state === "succeeded") return row.observation;
      throw error;
    }
  });
  await registerExitTools(
    app,
    providers,
    bundles,
    new WatchService(store.pool, providers, bundles),
  );
  return app;
}
