import type { Pool } from "pg";

const connections = new WeakMap<Pool, Set<Promise<void>>>();
export function trackPool(pool: Pool): Pool {
  if (connections.has(pool)) return pool;
  const open = new Set<Promise<void>>();
  connections.set(pool, open);
  pool.on("connect", (client) => {
    const closed = new Promise<void>((resolve) => client.once("end", resolve));
    open.add(closed);
    void closed.then(() => open.delete(closed));
  });
  return pool;
}

// pg-pool resolves end() after removing clients from its list, before their
// sockets necessarily close. Track actual connections from pool creation:
// failed connection attempts do not necessarily produce a remove event.
export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
  await Promise.all(connections.get(pool) ?? []);
}
