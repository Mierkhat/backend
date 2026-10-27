import { readFile, writeFile } from "node:fs/promises";
import { bundleSchema, decodeReceipt, rpc } from "../src/index.js";
const b = bundleSchema.parse(
  JSON.parse(
    await readFile(
      new URL("../deployments/index.json", import.meta.url),
      "utf8",
    ),
  )[0],
);
const s = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 12000,
});
const records = (await (
  await fetch(
    "https://horizon-testnet.stellar.org/transactions?order=asc&limit=1",
    { signal: AbortSignal.timeout(20000) },
  )
).json()) as {
  _embedded: {
    records: { hash: string; ledger: number; created_at: string }[];
  };
};
const first = records._embedded.records[0]!;
const rpcResult = await s.getTransaction(first.hash);
if (rpcResult.status !== "NOT_FOUND")
  throw Error("Chosen historical transaction remains in RPC retention");
const observation = await decodeReceipt(s, b, first.hash);
if (
  observation.state !== "succeeded" ||
  observation.provider !== "horizon-testnet.stellar.org" ||
  observation.receipt
)
  throw Error("Archive confirmation policy mismatch");
const evidence = {
  checkedAt: new Date().toISOString(),
  network: b.networkPassphrase,
  hash: first.hash,
  createdAt: first.created_at,
  rpcStatus: rpcResult.status,
  observation,
  assertions: {
    actualHistoricalTestnetTransaction: true,
    outsideRpcRetention: true,
    hashAndResultXdrVerified: true,
    noInventedGuardReceipt: true,
  },
};
await writeFile(
  new URL(
    "../../../contracts/evidence/archive-observation.json",
    import.meta.url,
  ),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "PASS actual historical transaction recovered beyond RPC retention",
  first.hash,
  observation.ledger,
);
