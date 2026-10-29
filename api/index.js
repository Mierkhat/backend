import { attachDatabasePool, waitUntil } from "@vercel/functions";
import { app, jobs, pool } from "../dist/server.js";

attachDatabasePool(pool);
/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
export default async function handler(request, response) {
  await app.ready();
  const finished = new Promise((resolve) => {
    response.once("finish", () => resolve(undefined));
    response.once("close", () => resolve(undefined));
  });
  app.server.emit("request", request, response);
  await finished;
  if (
    response.statusCode < 400 &&
    /^\/v1\/(?:exit\/submit|setup\/submit|transactions\/|setup\/transactions\/|watches(?:\/|\?|$))/.test(
      request.url ?? "",
    )
  )
    waitUntil(jobs.runWindow().catch(() => {}));
}
