import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  accountSchema,
  amountSchema,
  rawAmount,
  withdrawalReadiness,
  planWithdrawal,
  quoteMigration,
  assert,
  type DeploymentBundle,
} from "@mierkhat/sdk";
import type { Providers } from "./providers.js";
import { WatchService } from "./watches.js";
const common = z
  .object({
    owner: accountSchema,
    epoch: z.string().min(1).max(80),
    movementBps: z.number().int().min(1).max(500).default(50),
  })
  .strict();
const capability = z.string().regex(/^[a-f0-9]{64}$/);
export function exitToolPaths() {
  const post = (summary: string, schema: z.ZodType) => ({
    post: {
      summary,
      requestBody: {
        required: true,
        content: { "application/json": { schema: z.toJSONSchema(schema) } },
      },
      responses: {
        "200": {
          description:
            "Observed result; unknown data is never an executable guarantee",
        },
        "422": {
          description:
            "Unsupported route, invalid positive amount or rejected preflight",
        },
        "503": { description: "Provider unavailable" },
      },
    },
  });
  const headers = [
    {
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
    {
      name: "X-Watch-Key",
      in: "header",
      required: true,
      schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
      description: "Private browser capability; never put this in a URL",
    },
  ];
  return {
    "/v1/withdrawals/readiness": post(
      "Test a supported position's complete withdrawal",
      common,
    ),
    "/v1/withdrawals/plan": post(
      "Find a tested share spend for a receiving target",
      common.extend({ targetRaw: amountSchema }),
    ),
    "/v1/migrations/quote": post(
      "Simulate a bounded partial cross-asset migration",
      common.extend({ sharesRaw: amountSchema }),
    ),
    "/v1/watches": {
      ...post(
        "Create a seven-day opt-in in-app watch",
        common.extend({
          kind: z.enum(["exit", "migration"]),
          sharesRaw: amountSchema,
          minimumRaw: amountSchema,
        }),
      ),
      parameters: headers.slice(1),
    },
    "/v1/watches/{id}": {
      get: {
        summary: "Read a watch and its notifications",
        parameters: headers,
        responses: {
          "200": { description: "Private watch state" },
          "404": { description: "Missing, expired or incorrect capability" },
        },
      },
    },
    "/v1/watches/{id}/remove": {
      post: {
        summary: "Delete watch and notifications",
        parameters: headers,
        responses: {
          "200": { description: "Removed" },
          "404": { description: "Missing or incorrect capability" },
        },
      },
    },
    "/v1/watches/{id}/rearm": {
      post: {
        summary: "Explicitly rearm a condition notification",
        parameters: headers,
        responses: {
          "200": { description: "Rearmed" },
          "409": { description: "Missing or currently leased" },
        },
      },
    },
    "/v1/watches/{id}/seen": {
      ...post(
        "Mark a watch notification read",
        z.object({ notification: z.uuid() }).strict(),
      ),
      parameters: headers,
    },
  };
}
export async function registerExitTools(
  app: FastifyInstance,
  providers: Providers,
  bundles: DeploymentBundle[],
  watches: WatchService,
) {
  function bundle(epoch: string) {
    const b = bundles.find((b) => b.epoch === epoch);
    assert(b, "UnsupportedDeployment", "route.unsupported");
    return b;
  }
  app.post(
    "/v1/withdrawals/readiness",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (req) => {
      const d = common.parse(req.body),
        b = bundle(d.epoch);
      return providers.run(b.environment, (s) =>
        withdrawalReadiness(b, s, d.owner, d.movementBps),
      );
    },
  );
  app.post(
    "/v1/withdrawals/plan",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (req) => {
      const d = common.extend({ targetRaw: amountSchema }).parse(req.body),
        b = bundle(d.epoch);
      rawAmount(d.targetRaw);
      return providers.run(b.environment, (s) =>
        planWithdrawal(b, s, d.owner, d.targetRaw, d.movementBps),
      );
    },
  );
  app.post(
    "/v1/migrations/quote",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (req) => {
      const d = common.extend({ sharesRaw: amountSchema }).parse(req.body),
        b = bundle(d.epoch);
      rawAmount(d.sharesRaw);
      return providers.run(b.environment, (s) =>
        quoteMigration(b, s, d.owner, d.sharesRaw, d.movementBps),
      );
    },
  );
  app.post(
    "/v1/watches",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req) => {
      const d = common
        .extend({
          kind: z.enum(["exit", "migration"]),
          sharesRaw: amountSchema,
          minimumRaw: amountSchema,
        })
        .parse(req.body);
      rawAmount(d.sharesRaw);
      rawAmount(d.minimumRaw);
      return watches.create(d, capability.parse(req.headers["x-watch-key"]));
    },
  );
  const id = (req: { params: unknown }) =>
    z.object({ id: z.uuid() }).parse(req.params).id;
  const key = (req: { headers: Record<string, unknown> }) =>
    capability.parse(req.headers["x-watch-key"]);
  app.get("/v1/watches/:id", async (req, reply) => {
    const result = await watches.read(id(req), key(req));
    return (
      result ??
      reply.code(404).send({ code: "NotFound", copyKey: "watch.not_found" })
    );
  });
  app.post("/v1/watches/:id/remove", async (req, reply) =>
    (await watches.remove(id(req), key(req)))
      ? { removed: true }
      : reply.code(404).send({ code: "NotFound" }),
  );
  app.post("/v1/watches/:id/rearm", async (req, reply) =>
    (await watches.rearm(id(req), key(req)))
      ? { rearmed: true }
      : reply.code(409).send({ code: "WatchBusy", copyKey: "watch.busy" }),
  );
  app.post("/v1/watches/:id/seen", async (req, reply) => {
    const body = z.object({ notification: z.uuid() }).strict().parse(req.body);
    return (await watches.seen(id(req), key(req), body.notification))
      ? { seen: true }
      : reply.code(404).send({ code: "NotFound" });
  });
}
