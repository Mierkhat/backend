# Post-rejection backend and SDK plan

Baseline: `b09a7aa`, confirmed by the maintainer as the rejected submission.
Prepared 23 November 2026. The full cross-repository inventory, priorities and
development gates are in the [frontend review plan](https://github.com/Mierkhat/frontend/blob/main/docs/REVIEW_PLAN.md).
Rejection reasons are unknown; these are verified engineering findings.

## Implementation steps

1. Include migration destination instance/pair/code pins in `restorationKeys`,
   deduplicating exact ledger-key identities. Verify destination share decimals
   when loading a migration deployment. Preserve ABI, fee cap and signature policy.
2. Allow retryable SDK read errors to use the next configured provider after its
   network/freshness checks; deterministic signing/policy errors remain rejected.
3. Respect environment boundaries before dispatching setup transaction lookup.
4. Add meaningful SDK/provider/PostgreSQL regression coverage. Build and run app,
   SDK, script/API types, unit suites, database integration, security/release and
   compatibility checks.
5. Pack the reviewed SDK for both frontend consumers. Record source-tree and
   archive checksums; coordinate immutable sibling pins without an npm release.
6. Publish a baseline-relative change report and verification results, commit
   each verified implementation step, then push only when the whole project is done.

## Scope retained

The API verifies owner-signed canonical envelopes, commits encrypted exact bytes
before sending, reconciles by public hash with leased workers and preserves
terminal evidence with CAS. It never holds user signing keys. Migration uses a
separate pinned executable. The registry has six withdrawal and two migration
testnet profiles; strategy-free/self-issued fixtures are not external yield-vault
or mainnet acceptance. ABI generation, existing public receipts, replay and rollback
evidence remain distinct from new work and independent security review.

## Release dependency

The public Vercel account is paused (maintainer confirmation); health/network
requests return HTTP 402 `DEPLOYMENT_DISABLED`. Verify with real local PostgreSQL
and public testnet. Do not claim a production deployment. The local issuer is an
optional secure dependency; its absence must keep issuance unavailable.

Unattended watch timing depends on an active scheduler; the checked-in daily
Hobby cron alone cannot deliver minute-level checks. External partner validation,
strategy-aware profiles, true archived-to-live restoration, independent review
and mainnet approval remain separate development gates.
