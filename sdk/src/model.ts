import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const amountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(39);
export const accountSchema = z
  .string()
  .refine((v) => StrKey.isValidEd25519PublicKey(v));
export const contractSchema = z
  .string()
  .refine((v) => StrKey.isValidContract(v));
export const environmentSchema = z.enum(["local", "testnet", "mainnet"]);
export type Environment = z.infer<typeof environmentSchema>;
export const codePinSchema = z
  .object({ address: contractSchema, wasm_hash: hashSchema })
  .strict();
export const profileSchema = z
  .object({
    schema: z.literal(1),
    network_id: hashSchema,
    vault: codePinSchema,
    router: codePinSchema,
    factory: codePinSchema,
    settlement: contractSchema,
    assets: z
      .array(
        z
          .object({ asset: contractSchema, pair: codePinSchema.nullable() })
          .strict(),
      )
      .min(1)
      .max(2),
    max_seconds: z.literal(300),
    max_ledgers: z.literal(64),
  })
  .strict();
export type RouteProfile = z.infer<typeof profileSchema>;
export const intentSchema = z
  .object({
    schema: z.literal(1),
    network_id: hashSchema,
    guard: contractSchema,
    profile_hash: hashSchema,
    intent_id: hashSchema,
    owner: accountSchema,
    recipient: accountSchema,
    shares: amountSchema,
    min_withdraw: z.array(amountSchema).min(1).max(2),
    min_swap: z.array(amountSchema).min(1).max(2),
    min_receive: amountSchema,
    valid_before_time: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(20),
    valid_before_ledger: z.number().int().positive().max(4294967295),
  })
  .strict();
export type ExitIntent = z.infer<typeof intentSchema>;
export const bundleSchema = z
  .object({
    environment: environmentSchema,
    epoch: z.string().min(1).max(80),
    enabled: z.boolean(),
    networkPassphrase: z.string().min(1).max(200),
    guard: contractSchema,
    guardWasmHash: hashSchema,
    profileHash: hashSchema,
    profile: profileSchema,
    tokens: z
      .array(
        z
          .object({
            address: contractSchema,
            symbol: z.string().min(1).max(16),
            decimals: z.number().int().min(0).max(38),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    vaultName: z.string().min(1).max(80),
    shareDecimals: z.number().int().min(0).max(38),
    feeCeilingStroops: amountSchema,
    reviewed: z.boolean(),
  })
  .strict();
export type DeploymentBundle = z.infer<typeof bundleSchema>;
export interface ExitDraft {
  intent: ExitIntent;
  revision: number;
  environment: Environment;
  epoch: string;
}
export interface Ledger {
  sequence: number;
  timestamp: string;
  sourceSequence?: string;
}
export interface Review {
  reviewId: string | null;
  draft: ExitDraft;
  profile: RouteProfile;
  transactionXdr: string;
  envelopeDigest: string;
  intentHash: string;
  profileHash: string;
  observedAuthDigest: string;
  preparedLedger: number;
  preparedTime: string;
  expectedReceiveRaw: string;
  feeMaximumStroops: string;
}
export interface SignedAttempt {
  environment: Environment;
  epoch: string;
  txHash: string;
  signedEnvelopeDigest: string;
  signedXdr: string;
  review: Review;
}
export type AttemptState =
  | "recorded"
  | "pending"
  | "unknown"
  | "succeeded"
  | "failed";
export interface Receipt {
  intentId: string;
  intentHash: string;
  profileHash: string;
  owner: string;
  sharesSpent: string;
  received: string;
  withdrawn: string[];
  swappedOut: string[];
  ledger: number;
  timestamp: string;
}
export interface Observation {
  state: AttemptState;
  hash: string;
  ledger?: number;
  receipt?: Receipt;
  actualFee?: string;
  provider?: string;
  observedAt: string;
  rawStatus?: string;
}
export interface WalletAdapter {
  identity(): Promise<{ address: string; networkPassphrase: string }>;
  sign(
    transactionXdr: string,
    networkPassphrase: string,
    address: string,
  ): Promise<string>;
}
