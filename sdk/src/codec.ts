import { contract, hash, xdr } from '@stellar/stellar-sdk';
import entries from './generated/spec.json' with {type: 'json'};
import type { RouteProfile as ContractProfile, ExitIntent as ContractIntent } from './generated/types.js';
import type { ExitIntent, RouteProfile } from './model.js';
export const spec = new contract.Spec(entries);
export function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function unhex(s: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/.test(s)) throw new Error('Invalid hex');
  return Uint8Array.from(s.match(/../g)!, b => parseInt(b, 16));
}
export function digest(bytes: Uint8Array): string { return hex(hash(bytes)); }
export function networkId(passphrase: string): string { return digest(new TextEncoder().encode(passphrase)); }
function udt(name: string) { return xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({name: new TextEncoder().encode(name)})); }
export function nativeIntent(i: ExitIntent): ContractIntent {
  return {...i, network_id: unhex(i.network_id), profile_hash: unhex(i.profile_hash), intent_id: unhex(i.intent_id),
    shares: BigInt(i.shares), min_withdraw: i.min_withdraw.map(BigInt), min_swap: i.min_swap.map(BigInt),
    min_receive: BigInt(i.min_receive), valid_before_time: BigInt(i.valid_before_time)};
}
export function nativeProfile(p: RouteProfile): ContractProfile {
  const pin = (v: RouteProfile['vault']) => ({...v, wasm_hash: unhex(v.wasm_hash)});
  return {...p, max_seconds: BigInt(p.max_seconds), network_id: unhex(p.network_id), vault: pin(p.vault), router: pin(p.router), factory: pin(p.factory),
    assets: p.assets.map(a => ({asset: a.asset, pair: a.pair ? [pin(a.pair)] : []}))};
}
export function intentScVal(i: ExitIntent) { return spec.nativeToScVal(nativeIntent(i), udt('ExitIntent')); }
export function profileScVal(p: RouteProfile) { return spec.nativeToScVal(nativeProfile(p), udt('RouteProfile')); }
export const intentHash = (i: ExitIntent) => digest(intentScVal(i).toXDR());
export const profileHash = (p: RouteProfile) => digest(profileScVal(p).toXDR());
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return hex(value);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k,v])=>[k,jsonSafe(v)]));
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,jsonSafe(v)]));
  return value;
}
