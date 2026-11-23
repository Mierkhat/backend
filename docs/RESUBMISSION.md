# Backend and SDK changes since rejection

Rejected baseline: `b09a7aa`, confirmed by the maintainer. Verified 24 November
2026. Full system review and further development scope:
[frontend review plan](https://github.com/Mierkhat/frontend/blob/main/docs/REVIEW_PLAN.md).

| Commit | Completed work |
| --- | --- |
| `70b2099` | Baseline-relative review and implementation plan before code edits. |
| `2ea3a52` | Migration restoration now includes destination instance, conversion pairs and executable keys with deduplication. Loading verifies destination share decimals. |
| `f651c25` | Transient/retryable SDK reads can fail over to the next network/freshness-verified provider. Deterministic errors remain rejected. Retryable API errors use 503; setup hash lookup respects the requested environment. |
| `11760c3` | Local PostgreSQL stops after awaited worker/API/pool shutdown, with idempotent draining. Idle pool errors log only a bounded public code rather than an internal client dump. |

Build, app/SDK/script/API types passed. SDK: 40 tests versus baseline 38;
backend unit: 9 versus 8; real PostgreSQL/API integration: 19 versus 18.
Deployment registry check verified eight known/enabled testnet profiles.
Frozen install, production dependency audit, redacted history scan, workflow
syntax/action pins and 10 controlled release-boundary tests passed. Release
unit tests did not deploy anything. Local shutdown/restart reused persisted
PostgreSQL and stopped on signal without the observed idle-client exception.

Local API health returned ready. Fresh network endpoint returned protocol 30,
real vault supply and asset balances at ledger 5890605. Direct SDK/provider reads
also succeeded; 14/14 withdrawal restore dependencies were present at ledger
5890497. Intermittent provider failures were observed; uptime is not established.
No new signed Freighter acceptance or cold restoration was performed.

Frontend app/embed now consume the reviewed SDK archive. Its source tree is
`0a5cad9767d91f0e5aa9e8eed394fe348b09ef34`, unchanged by the server shutdown
and documentation updates. Archive provenance points to ancestor `f651c25`.
The contracts retain their deployed executables and ABI. Final immutable sibling
pins follow the documentation revisions; self pins precede pin-only commits.

Vercel remains paused (HTTP 402 DEPLOYMENT_DISABLED). Use `pnpm local` with
Node 24.22.1 and pnpm 12.15.0 for persistent local PostgreSQL and API on 3001.
Use the frontend dev server for the browser. Issuance still requires dedicated
secure issuer configuration. No hosting promotion is claimed.

Historical October evidence belongs to the rejected baseline. External useful
vault adoption, strategy-aware execution, measured unattended watch cadence,
true cold restoration, independent review and mainnet remain further gates.
The [cross-repository change ledger](https://github.com/Mierkhat/frontend/blob/main/docs/RESUBMISSION.md)
separates completed implementation from those dependencies.
