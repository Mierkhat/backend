import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Each cycle still uses the database leases in the individual services. */
export function createJobRunner(
  tasks: (() => Promise<unknown>)[],
  enabled = () => true,
) {
  let active: Promise<void> | undefined;
  let window: Promise<void> | undefined;
  function runOnce(): Promise<void> {
    if (active) return active;
    if (!enabled()) return Promise.resolve();
    active = (async () => {
      const results = await Promise.allSettled(tasks.map((task) => task()));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })().finally(() => {
      active = undefined;
    });
    return active;
  }
  function runWindow(): Promise<void> {
    if (window) return window;
    window = (async () => {
      for (let round = 0; round < 4 && enabled(); round++) {
        if (round)
          await new Promise<void>((resolve) => setTimeout(resolve, 15000));
        await runOnce();
      }
    })().finally(() => {
      window = undefined;
    });
    return window;
  }
  return {
    runOnce,
    runWindow,
    settle: async () => {
      await Promise.allSettled([active, window]);
    },
  };
}

export function registerScheduledJobs(
  app: FastifyInstance,
  secret: string | undefined,
  run: () => Promise<void>,
) {
  app.route({
    method: ["GET", "POST"],
    url: "/v1/internal/run",
    config: { rateLimit: false },
    handler: async (request, reply) => {
      const digest = (value: string) =>
        createHash("sha256").update(value).digest();
      if (
        !secret ||
        !timingSafeEqual(
          digest(request.headers.authorization ?? ""),
          digest("Bearer " + secret),
        )
      )
        return reply.code(401).send({ code: "Unauthorized" });
      await run();
      return { completed: true };
    },
  });
}
