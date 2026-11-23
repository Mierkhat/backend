import { expect, it } from "vitest";
import { Address, SorobanDataBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { loadDeployment } from "./rpc.js";
import { sdkFixture } from "./test-fixture.js";
import { bundleProfileScVal } from "./codec.js";

it("verifies the destination share denomination before admitting a migration deployment", async () => {
  const f = sdkFixture(true);
  const b = f.bundle;
  const pins = [
    { address: b.guard, wasm_hash: b.guardWasmHash },
    b.profile.vault, b.profile.router, b.profile.factory,
    ...b.profile.assets.flatMap((asset) => asset.pair ? [asset.pair] : []),
    b.migration!.destination,
  ];
  let destinationDecimals = b.migration!.destinationShareDecimals;
  let destinationReads = 0;
  const server = {
    getNetwork: async () => ({ passphrase: b.networkPassphrase }),
    getAccount: async () => ({ sequenceNumber: () => "1" }),
    getAccountEntry: async () => ({ signers: [], thresholds: { toBytes: () => new Uint8Array([1, 1, 1, 1]) } }),
    getLedgerEntries: async (...keys: { toXDR: (format: "base64") => string }[]) => ({
      entries: keys.map((key, n) => ({ key, val: {
        type: "contractData", contractData: { val: { type: "scvContractInstance", instance: {
          executable: n < pins.length
            ? { type: "contractExecutableWasm", wasmHash: pins[n]!.wasm_hash }
            : { type: "contractExecutableStellarAsset" },
        } } },
      } })),
    }),
    simulateTransaction: async (tx: { operations: unknown[] }) => {
      const op = tx.operations[0] as { func: { invokeContract: { contractAddress: Parameters<typeof Address.fromScAddress>[0]; functionName: string } } };
      const call = op.func.invokeContract;
      const address = Address.fromScAddress(call.contractAddress).toString();
      const method = call.functionName.toString();
      let retval;
      if (method === "profile") retval = bundleProfileScVal(b);
      else if (method === "symbol") retval = nativeToScVal(b.tokens.find(token => token.address === address)!.symbol);
      else {
        if (address === b.migration!.destination.address) destinationReads++;
        retval = nativeToScVal(address === b.migration!.destination.address ? destinationDecimals : 7, { type: "u32" });
      }
      return { id: "read", latestLedger: 100, minResourceFee: "1", transactionData: new SorobanDataBuilder(), result: { auth: [], retval } };
    },
  } as unknown as rpc.Server;
  expect(await loadDeployment(b, server, f.key.publicKey())).toEqual(b);
  destinationDecimals++;
  await expect(loadDeployment(b, server, f.key.publicKey())).rejects.toThrow("DestinationShareDecimals");
  expect(destinationReads).toBe(2);
});
