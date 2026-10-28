import { contract, hash, xdr } from "@stellar/stellar-sdk";
import entries from "./generated/spec.json" with { type: "json" };
import migrationEntries from "./generated/migration-spec.json" with { type: "json" };
import type {
  RouteProfile as ContractProfile,
  ExitIntent as ContractIntent,
} from "./generated/types.js";
import type { DeploymentBundle, ExitIntent, RouteProfile } from "./model.js";
export const spec = new contract.Spec(entries);
export const migrationSpec = new contract.Spec(migrationEntries);
export const rootMethod = (b: DeploymentBundle) =>
  b.migration ? "execute_migration" : "execute_exit";
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function unhex(s: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/.test(s)) throw new Error("Invalid hex");
  return Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));
}
export function digest(bytes: Uint8Array): string {
  return hex(hash(bytes));
}
export function networkId(passphrase: string): string {
  return digest(new TextEncoder().encode(passphrase));
}
function udt(name: string) {
  return xdr.ScSpecTypeDef.scSpecTypeUdt(
    new xdr.ScSpecTypeUdt({ name: new TextEncoder().encode(name) }),
  );
}
export function nativeIntent(i: ExitIntent): ContractIntent {
  const { migration: _, ...base } = i;
  return {
    ...base,
    network_id: unhex(i.network_id),
    profile_hash: unhex(i.profile_hash),
    intent_id: unhex(i.intent_id),
    shares: BigInt(i.shares),
    min_withdraw: i.min_withdraw.map(BigInt),
    min_swap: i.min_swap.map(BigInt),
    min_receive: BigInt(i.min_receive),
    valid_before_time: BigInt(i.valid_before_time),
  };
}
export function nativeProfile(p: RouteProfile): ContractProfile {
  const pin = (v: RouteProfile["vault"]) => ({
    ...v,
    wasm_hash: unhex(v.wasm_hash),
  });
  return {
    ...p,
    max_seconds: BigInt(p.max_seconds),
    network_id: unhex(p.network_id),
    vault: pin(p.vault),
    router: pin(p.router),
    factory: pin(p.factory),
    assets: p.assets.map((a) => ({
      asset: a.asset,
      pair: a.pair ? [pin(a.pair)] : [],
    })),
  };
}
export function intentScVal(i: ExitIntent) {
  return i.migration
    ? migrationSpec.nativeToScVal(
        {
          exit: nativeIntent(i),
          convert_inputs: i.migration.convert_inputs.map(BigInt),
          min_deposit: i.migration.min_deposit.map(BigInt),
          min_destination_shares: BigInt(i.migration.min_destination_shares),
        },
        udt("MigrationIntent"),
      )
    : spec.nativeToScVal(nativeIntent(i), udt("ExitIntent"));
}
export function profileScVal(p: RouteProfile) {
  return spec.nativeToScVal(nativeProfile(p), udt("RouteProfile"));
}
export const intentHash = (i: ExitIntent) => digest(intentScVal(i).toXDR());
export const profileHash = (p: RouteProfile) => digest(profileScVal(p).toXDR());
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return hex(value);
  if (value instanceof Map)
    return Object.fromEntries([...value].map(([k, v]) => [k, jsonSafe(v)]));
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]),
    );
  return value;
}

export function bundleProfileScVal(b: DeploymentBundle) {
  if (!b.migration) return profileScVal(b.profile);
  const pin = (p: RouteProfile["vault"]) => ({
    ...p,
    wasm_hash: unhex(p.wasm_hash),
  });
  return migrationSpec.nativeToScVal(
    {
      source: nativeProfile(b.profile),
      destination: pin(b.migration.destination),
      destination_assets: b.migration.destination_assets.map((a) => ({
        asset: a.asset,
        pair: a.pair ? [pin(a.pair)] : [],
      })),
    },
    udt("MigrationProfile"),
  );
}
export const bundleProfileHash = (b: DeploymentBundle) =>
  digest(bundleProfileScVal(b).toXDR());
export function decodeIntent(
  value: xdr.ScVal,
  b: DeploymentBundle,
): ExitIntent {
  if (!b.migration)
    return jsonSafe(spec.scValToNative(value, udt("ExitIntent"))) as ExitIntent;
  const v = jsonSafe(
    migrationSpec.scValToNative(value, udt("MigrationIntent")),
  ) as {
    exit: ExitIntent;
    convert_inputs: string[];
    min_deposit: string[];
    min_destination_shares: string;
  };
  const { exit, ...migration } = v;
  return { ...exit, migration };
}
