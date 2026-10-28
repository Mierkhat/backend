# Withdrawal planning, migration and condition watches

The SDK exports `withdrawalReadiness`, `planWithdrawal`, `quoteMigration` and the existing prepare/sign/submit/recovery functions. Supported scope is the pinned testnet registry: two strategy-free vaults, six withdrawal profiles and two separate immutable migration profiles. No mainnet signing is enabled.

## API

All quantities are integer strings in their exact token/share units; no floating-point amount arithmetic is used. Account addresses, epochs, movement bounds and positive quantities are validated. `movementBps` defaults to 50 and accepts 1–500. Read-only planning/preflight endpoints have their own rate limits.

| Method and path                  | Request                                                                | Result                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /v1/withdrawals/readiness` | `owner`, `epoch`, optional `movementBps`                               | Full/partial/blocked/setup/empty/unknown, observations and a tested quantity when available |
| `POST /v1/withdrawals/plan`      | Above plus `targetRaw`                                                 | Tested share quantity, quote and receiving-target draft/preflight                           |
| `POST /v1/migrations/quote`      | Above plus `sharesRaw`                                                 | Migration draft, bounded preflight, destination shares, deposits and refunds                |
| `POST /v1/exit/prepare`          | Existing draft format, with migration bounds for migration epochs      | Independently verifiable unsigned review with a saved review ID                             |
| `POST /v1/exit/submit`           | Existing exact signed envelope/review submission                       | Durable admission and hash recovery for either root method                                  |
| `POST /v1/watches`               | Owner/epoch, `kind`, `sharesRaw`, `minimumRaw`, optional `movementBps` | Watch ID and expiry                                                                         |
| `GET /v1/watches/{id}`           | Private capability header                                              | Observation and recent notifications                                                        |
| `POST /v1/watches/{id}/seen`     | `notification` UUID                                                    | Mark notification read                                                                      |
| `POST /v1/watches/{id}/rearm`    | Empty object                                                           | Explicitly request another eligibility notification                                         |
| `POST /v1/watches/{id}/remove`   | Empty object                                                           | Delete watch and cascading notifications                                                    |

Every watch request requires `X-Watch-Key`, a client-generated 32-byte random capability encoded as 64 lowercase hexadecimal characters. Never put it in a URL, log or public artifact. The server stores SHA-256 of the capability. Correct IDs with incorrect capabilities receive the same missing result. An address is not an authorization credential. These capabilities grant access to watch data only and cannot move funds.

`GET /v1/openapi.json` includes these routes. Readiness is an observation, not a liquidity reservation. Unknown data must remain unknown. A tested full flow is distinct from a mathematical maximum, future guaranteed execution or a fiat-value guarantee. Receiving-target planning currently uses one selected position.

## Migration policy

`DeploymentBundle.migration` binds destination identity, asset routes and display metadata. Its profile hash encodes the source route and destination configuration. `ExitIntent.migration` supplies conversion inputs, deposit minima and minimum destination shares. The contract invocation encodes a distinct `MigrationIntent` and invokes `execute_migration`; ordinary exits retain `execute_exit` and their original ABI.

Envelope verification still permits exactly one owner root and its exact source-share transfer. Destination deposits and conversions use the guard's own bounded nested authority. Destination identities, changed bounds, extra authorization, domain changes and changed transaction bodies reject before submission. Receipts include a migration object with destination-share, deposit, conversion and refund data. RPC recovery binds the receipt to the actual root invocation and signed intent.

## Durable watches

Migration `004_withdrawal_watches.sql` stores observations and notifications separately from signed transaction payloads. It never stores wallet signatures or standing authorization. Workers claim a due watch using a database lease and `SKIP LOCKED`, then run a real complete preflight. A lease compare-and-set prevents an expired worker from publishing over a successor.

Only an unmet-to-met transition or an explicit rearm creates a new notification. A first successful observation also notifies. Repeated met states do not duplicate; unknown preserves the last known eligibility and does not rearm it. Updates, cycle increments and notification insertion commit in one database transaction. Removal cascades to notifications. Expired watches are pruned.

The minimum scheduling interval is 60 seconds; it is not a delivery SLA. Provider availability, the current 120-second lease and worker capacity affect timing. Seven-day expiry and creation/rate/capacity limits bound retention and work. In-app delivery requires no external recipient or service. Browser permission is handled by the frontend.

## Test and operate

Run `pnpm test:integration` for the real PostgreSQL capability, concurrency, deduplication, unknown-state, restart-instance, expiry and deletion tests. Existing submission recovery tests remain in the same suite. Run the SDK suite for migration root/intent/auth/budget mutation checks and exact integer handling.

`sdk/scripts/testnet-migration-routes.ts` deploys/verifies the two actual profiles and records hash-based checkpoints. `sdk/scripts/testnet-migration-rollback.ts` deliberately submits one failing testnet migration and compares every non-account footprint value. It uses dedicated ignored testnet credentials, never a personal account. Do not rerun with a new action while its saved hash remains uncertain. Genuine wallet acceptance lives in the frontend helper and contracts evidence. A fresh clone does not include test keys or an initialized extension profile.
