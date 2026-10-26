import { Pool } from "pg";
import { Store } from "./store.js";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await new Store(pool, Buffer.alloc(32)).migrate();
} finally {
  await pool.end();
}
