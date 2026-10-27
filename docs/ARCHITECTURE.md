# Architecture

The frontend owns wallet interaction; the SDK independently verifies what is signed. The API prepares supported actions and persists submissions. PostgreSQL holds durable attempts, encrypted payloads, leases and observations. Workers reconcile attempts against fixed RPC targets. The immutable guard enforces signed withdrawal conditions.

## Guarded withdrawal

1. Read the pinned deployment, owner and fresh ledger state.
2. Quote exact shares and conversions. The user selects a minimum; the quote does not promise a result.
3. Build/simulate the intent and return an unsigned review containing exact bounds, fees, authorization and envelope digest.
4. The client verifies the review and wallet identity before signing.
5. The API verifies exact signed bytes and commits an attempt before a worker sends it. Duplicate admission resolves to the supported existing attempt.
6. Workers observe the public hash and save terminal evidence. Clients verify committed guard metadata before displaying a Mierkhat receipt.

Setup has separate typed policies for trustlines, deposits and a single restoration operation. It cannot be mixed into an exit. Unsupported roots, sources, signatures, bounds and nested transfers are rejected.

## Identity and recovery

The intent hash identifies contract arguments and the replay domain. The Stellar transaction hash identifies a transaction for network lookup, not its signatures. The signed envelope digest identifies exact retry bytes. Retries preserve these bytes instead of requesting another signature for an uncertain action.

Migrations use an advisory lock. Admission commits encrypted bytes before sends. Leases coordinate workers and terminal compare-and-set prevents late writes from downgrading a known result. Idempotency/envelope conflicts are explicit errors.

Timeout or NOT_FOUND remains unresolved. Horizon can recover historical transactions outside RPC retention but does not return contract metadata; generic success is not fabricated into a guard receipt. Deployment/code/asset/profile pins and network epochs remain trusted boundaries. The optional dedicated testnet issuer is unrelated to user signing.
