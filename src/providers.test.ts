import { afterEach, it, expect, vi } from "vitest";
import { rpc } from "@mierkhat/sdk";
import { Providers } from "./providers.js";
afterEach(() => vi.restoreAllMocks());
it("rejects environments without configured providers without invoking caller work", async () => {
  let invoked = false;
  await expect(
    new Providers({}, {}).run("unconfigured", async () => {
      invoked = true;
    }),
  ).rejects.toThrow("ProvidersUnavailable");
  expect(invoked).toBe(false);
});
it("rejects a wrong network fallback and only calls work on a fresh matching network", async () => {
  const getNetwork = vi
    .spyOn(rpc.Server.prototype, "getNetwork")
    .mockResolvedValueOnce({ passphrase: "wrong", protocolVersion: "29" })
    .mockResolvedValue({ passphrase: "expected", protocolVersion: "29" });
  vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
    sequence: 100,
    closeTime: String(Math.floor(Date.now() / 1000)),
  } as Awaited<ReturnType<rpc.Server["getLatestLedger"]>>);
  const providers = new Providers(
    { testnet: ["https://first.example", "https://second.example"] },
    { testnet: "expected" },
  );
  let calls = 0;
  expect(
    await providers.run("testnet", async () => {
      calls++;
      return "fresh";
    }),
  ).toBe("fresh");
  expect(calls).toBe(1);
  expect(getNetwork).toHaveBeenCalledTimes(2);
});
it("does not let a stale ledger reach construction", async () => {
  vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
    passphrase: "expected",
    protocolVersion: "29",
  });
  vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
    sequence: 100,
    closeTime: "1",
  } as Awaited<ReturnType<rpc.Server["getLatestLedger"]>>);
  let calls = 0;
  await expect(
    new Providers(
      { testnet: ["https://first.example"] },
      { testnet: "expected" },
    ).run("testnet", async () => {
      calls++;
    }),
  ).rejects.toThrow("ProvidersUnavailable");
  expect(calls).toBe(0);
});
