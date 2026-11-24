import type { Pool } from "pg";

// pg-pool resolves end() after removing clients from its list, before their
// sockets necessarily close. Wait for the public remove events as well before
// a local launcher stops PostgreSQL.
export async function closePool(pool: Pool): Promise<void> {
  let remaining = pool.totalCount;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const removed = () => { if (--remaining === 0) resolveClosed(); };
  pool.on("remove", removed);
  if (remaining === 0) resolveClosed();
  try {
    await pool.end();
    await closed;
  } finally {
    pool.off("remove", removed);
  }
}
