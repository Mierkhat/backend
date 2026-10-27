# HTTP API and SDK

The service uses strict JSON/Zod validation under `/v1`. `/v1/openapi.json` is generated from actual validators. A publication-time [snapshot](openapi.json) is included; the running service remains authoritative.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/health` | Database readiness |
| GET | `/v1/network` | Current testnet network state |
| GET | `/v1/accounts/{owner}` | Account, share and token balances for an optional `epoch` query |
| GET | `/v1/accounts/{owner}/positions` | Actual positive share balances grouped once per supported vault |
| GET | `/v1/environments` | Enabled deployment bundles |
| GET | `/v1/profiles/{profileHash}` | Pinned profile |
| POST | `/v1/testnet/fund` | Real Friendbot native funding |
| POST | `/v1/testnet/faucet` | Real configured issuer payments |
| POST | `/v1/setup/prepare` | Typed trustline, deposit or restoration preparation |
| POST | `/v1/setup/submit` | Verify and durably accept signed setup bytes |
| GET | `/v1/setup/transactions/{hash}` | Setup observation |
| POST | `/v1/exit/quote` | Share withdrawal and conversion quote |
| POST | `/v1/exit/prepare` | Guard intent and unsigned review |
| POST | `/v1/exit/submit` | Verify and durably accept signed guard bytes |
| GET | `/v1/reviews/{reviewId}` | Stored review |
| GET | `/v1/transactions/{hash}` | Guard transaction observation |

Consult the schema for required query/body fields. Exit submissions bind environment, deployment epoch, signed XDR, claimed hash and optional review ID. Idempotency uses `Idempotency-Key`. Conflicting or unsupported envelopes are rejected, never silently rewritten.

## Vault and output selection

A position is a live share balance in one configured vault. Multiple deposits and multiple output profiles do not create duplicate positions. `GET /v1/accounts/{owner}/positions` returns `owner`, `ledger` and `positions`; each position contains `vault`, `vaultName`, `shareDecimals`, `sharesRaw` and the available `routeEpochs`. A failed balance read fails the request rather than returning an invented zero. This discovers holdings across the supported registry, not arbitrary Stellar contracts.

Accounts accept an optional `epoch` query. Quote and setup preparation accept an optional `epoch` body field; omission retains the original default route for existing clients. Unknown/disabled routes fail before provider access. Exit preparation/submission already bind the epoch and exact profile in the intent. Setup verification selects the registered bundle by the review's epoch, rather than the first network bundle.

The faucet accepts an optional `epoch`, grants that route's supported tokens, and tracks the actual asset IDs issued per account over twenty-four hours. Changing routes cannot grant the same token again. Older whole-token grants remain recognized. Public grant metadata contains asset IDs; exact payment bytes remain encrypted.

For a tracked exit, receipt decoding uses its stored epoch. For an untracked hash or direct browser fallback, `decodeKnownReceipt` selects a trusted bundle by the actual guard invocation and independently verifies the receipt. The interface resolves token metadata from that verified receipt's profile hash.

## Amounts and SDK

Raw quantities are integer strings, not floating-point JSON numbers. Token metadata controls display conversion; shares, assets, settlement and fee stroops are distinct units. A quote estimate is not the signed minimum. Intent hash, transaction hash and signed-envelope digest serve different purposes; see [architecture](ARCHITECTURE.md).

`sdk/src/index.ts` exports amount conversion, generated ABI types, deployment validation, network/account reads, quotes, preparation, independent review/signature verification, signing, submission, receipt decoding and recovery. `ExitController` invalidates stale reviews and wallet prompts when identity/epoch changes.

Build with `pnpm --filter @mierkhat/sdk build`. Pack with `pnpm --filter @mierkhat/sdk pack --pack-destination <destination>`, record checksum/source commit and update both frontend/embed archive references together. Packing does not publish to npm.
