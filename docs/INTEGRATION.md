# Cross-repository acceptance

The build, types and provider/SDK/PostgreSQL suites run independently. Live acceptance additionally needs sibling clones named `frontend`, `backend` and `contracts`; retained acceptance harnesses resolve those names from the parent directory.

Run the actual API and frontend. The testnet issuer is a protected prerequisite, not part of source. No historical keys or retry payloads are shipped.

- `sdk/scripts/testnet-fixture.ts` builds/deploys a dedicated fixture using sibling WASM. Public evidence goes into `contracts/evidence/`; private keys/retries remain in parent `.tooling/testnet/`.
- `sdk/scripts/testnet-journey.ts` needs that fixture issuer and a dedicated test account. It verifies real funding, trustlines, issuance, deposit, exit and balance invariants.
- `scripts/testnet-crash.ts` needs the journey test account. It runs its own PostgreSQL/API, kills the accepted-before-send process and verifies the original hash after restart.
- `sdk/scripts/check-testnet-resources.ts` and `check-testnet-archive.ts` save actual network observations to sibling contract evidence.

These are acceptance tools, not startup steps. They submit real testnet transactions; they do not silently use personal wallet funds. Saved public evidence can be inspected without regenerating accounts.

Regenerate bindings from the CLI-built WASM from the backend root:

```sh
pnpm --filter @mierkhat/sdk exec tsx scripts/generate-bindings.ts "$PWD/../contracts/target/wasm32v1-none/release/mierkhat_guard.wasm"
```

Use an absolute path. Generated types/spec are committed, so ordinary SDK/app consumers do not need Rust or Stellar CLI. See [contracts evidence](https://github.com/Mierkhat/contracts/blob/main/docs/EVIDENCE.md) and its release status for exact observations and remaining gates.

## Response loss, concurrent providers and process recovery

From the backend root, run `pnpm exec tsx scripts/testnet-recovery-matrix.ts` after the dedicated journey account has been funded and received real test tokens. The runner reuses its actual shares or makes a real deposit when needed. It starts temporary PostgreSQL and separate API processes, submits genuine guarded transactions and checks ledger balances and receipts. Fault relays forward real RPC/HTTP traffic and deliberately drop selected responses; they never fabricate chain results. Only the runner's own API processes are killed. OpenSSL is required for the temporary HTTPS relay certificate.

The corpus covers HTTP response loss after durable admission, simultaneous admission/provider sends and two worker processes, RPC response loss after actual acceptance, and SIGKILL after acceptance before observation. It records exact signed-envelope digests without recording signed bytes. The public in-flight checkpoint lives in the sibling parent `.tooling/testnet/recovery-matrix-public.json`; successful public evidence is written into `contracts/evidence/testnet-recovery-matrix.json`.

The independently operated SDF and Tatum endpoints both acknowledged the same transaction as PENDING in the recorded run. Tatum's unauthenticated endpoint allows only five requests per minute, so it is used sparingly and the runner leaves real rate windows between fallback cases. It is not added as an unrestricted default production provider. These four boundaries are verified, not a claim that all possible fault interleavings have been exhausted.

## Actual archival readiness

With a sibling contracts checkout, run `pnpm --filter @mierkhat/sdk check:restoration` to inspect all fixed contract-instance and code entries on the real network. The public report distinguishes live entries from missing entries requiring archive verification and records the earliest actual expiry ledger. It never treats a missing RPC entry alone as proof of archival.

Once entries actually expire, `pnpm --filter @mierkhat/sdk check:restoration -- --restore` uses the dedicated test account and normal preparation/signature policy for a separate RestoreFootprint transaction. It records the public hash before submission, requires the missing entries to become live, and re-verifies the immutable deployment. Live entries do not satisfy archived-state acceptance. Public testnet TTL cannot be shortened; cold/restored resource measurement must follow a genuine transition.
