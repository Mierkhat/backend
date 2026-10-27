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
export function readPendingRecords(
  storage: Pick<RecoveryStorage, "length" | "key" | "getItem">,
): RecoveryRecord[] {
  const records: RecoveryRecord[] = [];
  try {
    for (let n = 0; n < storage.length; n++) {
      const key = storage.key(n);
      if (!key?.startsWith("mierkhat.pending.")) continue;
      try {
        const result = recoveryRecordSchema.safeParse(
          JSON.parse(storage.getItem(key) ?? "null"),
        );
        if (result.success && key === recoveryKey(result.data))
          records.push(result.data);
      } catch {
        /* One corrupt record must not hide the other hashes. */
      }
    }
  } catch {
    /* Storage access can be denied without invalidating in-memory tracking. */
  }
  return records.sort(
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
    const key = recoveryKey(result.data),
      json = JSON.stringify(result.data);
    let prior: ReturnType<typeof recoveryRecordSchema.safeParse> | undefined;
    try {
      prior = recoveryRecordSchema.safeParse(
        JSON.parse(storage.getItem(key) ?? "null"),
      );
    } catch {}

    if (
      prior?.success &&
      prior.data.hash === result.data.hash &&
      prior.data.environment === result.data.environment &&
      prior.data.terminal
    )
      return true;
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
  try {
    const prior = recoveryRecordSchema.safeParse(
      JSON.parse(storage.getItem(recoveryKey(pointer)) ?? "null"),
    );
    if (
      prior.success &&
      prior.data.hash === pointer.hash &&
      prior.data.environment === pointer.environment &&
      prior.data.terminal
    )
      return true;
  } catch {}
  const record = recoveryRecordSchema.safeParse({
    ...pointer,
    state: observation.state,
    terminal:
      observation.state === "succeeded" || observation.state === "failed",
  });
  return record.success && rememberPending(record.data, storage);
}
