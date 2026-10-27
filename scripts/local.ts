/** Persistent local PostgreSQL and API. Credentials live only in ignored mode 0600 files. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
const parent = resolve(fileURLToPath(new URL("../..", import.meta.url))),
  // Preserve the combined workspace's existing database; standalone clones keep
  // local credentials and data inside their own ignored repository directory.
  root = existsSync(resolve(parent, "scripts/export_facet.py"))
    ? parent
    : resolve(fileURLToPath(new URL("..", import.meta.url))),
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
process.env.ALLOWED_ORIGINS ??=
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173";
if (!process.env.TESTNET_FAUCET_KEY_FILE) {
  const candidate = resolve(root, ".tooling/testnet/keys.json");
  try {
    await access(candidate);
    process.env.TESTNET_FAUCET_KEY_FILE = candidate;
  } catch {
    /* Read-only CI and standalone setups can run without an issuer secret. */
  }
}
await import("../src/server.js");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    setTimeout(() => {
      void pg.stop();
    }, 2000);
  });
