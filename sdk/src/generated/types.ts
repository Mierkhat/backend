// Generated from compiled guard ABI. Do not edit.
import type { u32, u64, i128, Option } from "@stellar/stellar-sdk/contract";
export interface CodePin {
  address: string;
  wasm_hash: Uint8Array;
}

export interface AssetRoute {
  asset: string;
  pair: Array<CodePin>;
}

export interface ExitIntent {
  guard: string;
  intent_id: Uint8Array;
  min_receive: i128;
  min_swap: Array<i128>;
  min_withdraw: Array<i128>;
  network_id: Uint8Array;
  owner: string;
  profile_hash: Uint8Array;
  recipient: string;
  schema: u32;
  shares: i128;
  valid_before_ledger: u32;
  valid_before_time: u64;
}

export interface ExitReceipt {
  intent_hash: Uint8Array;
  intent_id: Uint8Array;
  ledger: u32;
  owner: string;
  profile_hash: Uint8Array;
  received: i128;
  shares_spent: i128;
  swapped_out: Array<i128>;
  timestamp: u64;
  withdrawn: Array<i128>;
}

export interface RouteProfile {
  assets: Array<AssetRoute>;
  factory: CodePin;
  max_ledgers: u32;
  max_seconds: u64;
  network_id: Uint8Array;
  router: CodePin;
  schema: u32;
  settlement: string;
  vault: CodePin;
}
