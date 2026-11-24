import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import type { Pool } from "pg";
import { closePool, trackPool } from "./close-pool.js";

it("waits for connected sockets after end resolves without waiting for failed connection attempts", async () => {
  const events = Object.assign(new EventEmitter(), {
    totalCount: 2, // One established socket, one connection attempt that fails.
    end: async () => { events.totalCount = 0; },
  });
  const pool = trackPool(events as unknown as Pool), client = new EventEmitter();
  events.emit("connect", client);
  let stopped = false;
  const closed = closePool(pool).then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(stopped).toBe(false);
  client.emit("end");
  await closed;
  expect(stopped).toBe(true);
});

it("finishes an empty tracked pool without requiring a removal event", async () => {
  const events = Object.assign(new EventEmitter(), { end: async () => {} });
  await expect(closePool(trackPool(events as unknown as Pool))).resolves.toBeUndefined();
});
