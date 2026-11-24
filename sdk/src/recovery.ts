import { z } from "zod";
import { accountSchema, hashSchema, type Observation } from "./model.js";
import type { PendingPointer } from "./controller.js";
export const recoveryRecordSchema = z
  .object({
    environment: z.enum(["local", "testnet"]),
    epoch: z.string().max(80),
    hash: hashSchema,
    intentHash: z.union([hashSchema, z.literal("")]),
    createdAt: z.iso.datetime(),
    owner: accountSchema.optional(),
    kind: z
      .enum(["exit", "deposit", "trustlines", "faucet", "restore"])
      .optional(),
    terminal: z.boolean().optional(),
    state: z
      .enum(["recorded", "pending", "unknown", "succeeded", "failed"])
      .optional(),
  })
  .strict()
  .refine(
    (v) => !v.terminal || v.state === "succeeded" || v.state === "failed",
  );
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
export interface RecoveryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export const recoveryKey = (p: Pick<PendingPointer, "environment" | "hash">) =>
  `mierkhat.pending.${p.environment}.${p.hash}`;
const terminalKey = (p: Pick<PendingPointer, "environment" | "hash">) =>
  `mierkhat.terminal.${p.environment}.${p.hash}`;
function storedRecord(storage: Pick<RecoveryStorage, "getItem">, key: string) {
  try {
    const result = recoveryRecordSchema.safeParse(
      JSON.parse(storage.getItem(key) ?? "null"),
    );
    return result.success &&
      (key === recoveryKey(result.data) ||
        (result.data.terminal && key === terminalKey(result.data)))
      ? result.data
      : undefined;
  } catch {
    return undefined;
  }
}
export function readPendingRecords(
  storage: Pick<RecoveryStorage, "length" | "key" | "getItem">,
): RecoveryRecord[] {
  const records = new Map<string, RecoveryRecord>();
  try {
    for (let n = 0; n < storage.length; n++) {
      const key = storage.key(n);
      if (!key || !/^mierkhat\.(pending|terminal)\./.test(key)) continue;
      const record = storedRecord(storage, key);
      if (!record) continue;
      const identity = recoveryKey(record), prior = records.get(identity);
      if (!prior?.terminal || record.terminal) records.set(identity, record);
    }
  } catch {
    /* Storage access can be denied without invalidating in-memory tracking. */
  }
  return [...records.values()].sort(
    (a, b) =>
      Number(!!a.terminal) - Number(!!b.terminal) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}
export function rememberPending(
  pointer: PendingPointer | RecoveryRecord,
  storage: Pick<RecoveryStorage, "getItem" | "setItem">,
): boolean {
  const result = recoveryRecordSchema.safeParse(pointer);
  if (!result.success) return false;
  try {
    const completedKey = terminalKey(result.data);
    if (storedRecord(storage, completedKey)?.terminal) return true;
    const prior = storedRecord(storage, recoveryKey(result.data));
    // Promote legacy terminal records. Pending writers use a different key,
    // so a stale read in another tab cannot overwrite this terminal evidence.
    const record = prior?.terminal ? prior : result.data;
    const key = record.terminal ? completedKey : recoveryKey(record),
      json = JSON.stringify(record);
    storage.setItem(key, json);
    return storage.getItem(key) === json;
  } catch {
    return false;
  }
}
export function rememberObservation(
  pointer: PendingPointer,
  observation: Observation,
  storage: Pick<RecoveryStorage, "getItem" | "setItem">,
): boolean {
  if (pointer.hash !== observation.hash) return false;
  const record = recoveryRecordSchema.safeParse({
    ...pointer,
    state: observation.state,
    terminal:
      observation.state === "succeeded" || observation.state === "failed",
  });
  return record.success && rememberPending(record.data, storage);
}
