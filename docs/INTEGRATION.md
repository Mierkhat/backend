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
