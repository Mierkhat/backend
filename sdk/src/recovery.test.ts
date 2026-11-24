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
  expect(rememberPending(pointer, s)).toBe(true);
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

it("replaces a corrupt record at the same hash instead of treating available storage as denied", () => {
  const s = storage();
  s.setItem(recoveryKey(pointer), "{");
  expect(rememberPending(pointer, s)).toBe(true);
  expect(readPendingRecords(s)).toEqual([pointer]);
});

it("keeps terminal evidence when another tab writes after reading an old pending value", () => {
  const s = storage();
  rememberPending(pointer, s);
  let raced = false;
  const otherTab = {
    getItem(key: string) {
      const old = s.getItem(key);
      if (!raced && key === recoveryKey(pointer)) {
        raced = true;
        expect(rememberObservation(pointer, {
          hash: pointer.hash, state: "succeeded", observedAt: pointer.createdAt,
        }, s)).toBe(true);
      }
      return old;
    },
    setItem: s.setItem,
  };
  expect(rememberPending({ ...pointer, state: "unknown" }, otherTab)).toBe(true);
  expect(JSON.parse(s.getItem(recoveryKey(pointer))!).state).toBe("unknown");
  const reloaded = readPendingRecords(s);
  expect(reloaded).toHaveLength(1);
  expect(reloaded[0]).toMatchObject({ terminal: true, state: "succeeded" });
});

it("promotes legacy terminal records and ignores corrupt terminal sidecars", () => {
  const s = storage();
  const legacy = { ...pointer, state: "failed", terminal: true };
  s.setItem(recoveryKey(pointer), JSON.stringify(legacy));
  expect(rememberPending(pointer, s)).toBe(true);
  s.setItem(recoveryKey(pointer), JSON.stringify(pointer));
  expect(readPendingRecords(s)).toEqual([legacy]);
  const other = { ...pointer, hash: "ab".repeat(32) };
  s.setItem(`mierkhat.terminal.testnet.${other.hash}`, "{");
  expect(rememberPending(other, s)).toBe(true);
  expect(readPendingRecords(s)).toContainEqual(other);
});
