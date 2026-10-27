/** Persistent local PostgreSQL and API. Credentials live only in ignored mode 0600 files. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url))),
  dir = resolve(root, ".tooling/local");
await mkdir(dir, { recursive: true, mode: 0o700 });
let config: { password: string; payloadKey: string };
try {
  config = JSON.parse(await readFile(resolve(dir, "config.json"), "utf8"));
} catch {
  config = {
    password: randomBytes(24).toString("hex"),
    payloadKey: randomBytes(32).toString("hex"),
  };
  await writeFile(resolve(dir, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
}
const pg = new EmbeddedPostgres({
  databaseDir: resolve(dir, "postgres"),
  port: 55432,
  user: "postgres",
  password: config.password,
  persistent: true,
  initdbFlags: ["--locale=C", "--lc-messages=C"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
try {
  await access(resolve(dir, "postgres/PG_VERSION"));
} catch {
  await pg.initialise();
}
await pg.start();
console.log("Persistent PostgreSQL ready on 127.0.0.1:55432");
process.env.DATABASE_URL = `postgresql://postgres:${config.password}@127.0.0.1:55432/postgres`;
process.env.PAYLOAD_KEY = config.payloadKey;
process.env.ALLOWED_ORIGINS =
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173";
process.env.TESTNET_FAUCET_KEY_FILE = resolve(
  root,
  ".tooling/testnet/keys.json",
);
await import("../src/server.js");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    setTimeout(() => {
      void pg.stop();
    }, 2000);
  });
