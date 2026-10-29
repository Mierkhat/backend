import type { IncomingMessage, ServerResponse } from "node:http";
import { attachDatabasePool, waitUntil } from "@vercel/functions";
import { app, jobs, pool } from "../dist/server.js";

attachDatabasePool(pool);
export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
) {
  await app.ready();
  const finished = new Promise<void>((resolve) => {
    response.once("finish", resolve);
    response.once("close", resolve);
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
