import { it, expect } from "vitest";
import {
  readPendingRecords,
  rememberPending,
  rememberObservation,
  recoveryKey,
} from "./recovery.js";
const pointer = {
  environment: "testnet",
  epoch: "fixture",
  hash: "01".repeat(32),
  intentHash: "02".repeat(32),
  createdAt: "2026-10-27T10:00:00.000Z",
};
function storage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (n: number) => [...data.keys()][n] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}
it("keeps valid recovery records when adjacent entries are corrupt or have the wrong identity", () => {
  const s = storage();
  expect(rememberPending(pointer, s)).toBe(true);
  s.setItem("mierkhat.pending.testnet.corrupt", "{");
  s.setItem("mierkhat.pending.testnet.spoof", JSON.stringify(pointer));
  s.setItem(
    "mierkhat.pending.testnet.invalid",
    JSON.stringify({ ...pointer, createdAt: null }),
  );
  expect(readPendingRecords(s)).toEqual([pointer]);
});
it("never persists a signed payload through the public pointer interface", () => {
  const s = storage();
  expect(
    rememberPending({ ...pointer, signedXdr: "secret" } as typeof pointer, s),
  ).toBe(false);
  expect(s.length).toBe(0);
});
it("preserves terminal evidence against a delayed unknown observation", () => {
  const s = storage();
  rememberPending(pointer, s);
  rememberObservation(
    pointer,
    { hash: pointer.hash, state: "succeeded", observedAt: pointer.createdAt },
    s,
  );
  rememberObservation(
    pointer,
    { hash: pointer.hash, state: "unknown", observedAt: pointer.createdAt },
    s,
  );
  expect(readPendingRecords(s)[0]?.state).toBe("succeeded");
  expect(
    rememberObservation(
      pointer,
      { hash: "ff".repeat(32), state: "failed", observedAt: pointer.createdAt },
      s,
    ),
  ).toBe(false);
});
it("returns a usable failure signal when storage is denied", () => {
  const s = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("denied");
    },
  };
  expect(rememberPending(pointer, s)).toBe(false);
  expect(
    rememberObservation(
      pointer,
      { hash: pointer.hash, state: "pending", observedAt: pointer.createdAt },
      s,
    ),
  ).toBe(false);
});
