# Mierkhat backend and SDK

Fastify preparation/status service, PostgreSQL durable tracking and a separately publishable `sdk/` package. The service has no signing keys. Submission only accepts the exact supported source-account guard invocation, records the transaction before sending, encrypts exact retry bytes, and reconciles unknown results by public hash.

Use Node 24.22.1 and pnpm 12.15.0. From the combined root:

```sh
./scripts/pnpm build
cp backend/.env.example backend/.env
```

Fill `POSTGRES_PASSWORD` and the matching `DATABASE_URL` locally. Generate `PAYLOAD_KEY` with `openssl rand -hex 32`; keep it in secure server configuration. It must survive restarts for recovery of outstanding payloads. Never expose it through Vite or commit `.env`. Then run `docker compose up -d` inside backend and `../scripts/pnpm --filter @mierkhat/backend dev`. The server loads its own `.env`, applies advisory-lock-serialized migrations, and listens on 127.0.0.1:3001. Production uses `pnpm start` after the build.

`GET /v1/openapi.json` describes request schemas generated from the actual Zod validators. `/v1/health` checks the database. The default deployment registry at `sdk/deployments/index.json` contains one disabled, concrete testnet proof profile for read-only recovery; no signing route is enabled. Fixed RPC targets and allowed browser origins come from server configuration. API discovery cannot create trusted browser deployment pins.

```sh
# From the combined root
./scripts/pnpm --filter @mierkhat/backend test
./scripts/pnpm test:integration
./scripts/pnpm --filter @mierkhat/sdk test
./scripts/pnpm check:deployments
```

Integration tests start a temporary real PostgreSQL17.6 process, require a non-root Linux account, use a random local password and remove their cluster afterward. Tests verify concurrent deduplication, exact authenticated encryption, idempotency/envelope conflicts, leases, terminal CAS, expired payload exclusion and HTTP tracking semantics. They never send transactions.

Retention: signed bytes and idempotency keys expire at 24 hours; signed bytes are deleted immediately on terminal evidence. Unsigned reviews are pruned 24 hours after expiry. Terminal tracking metadata is retained for 90 days. Unresolved public hashes remain available for reconciliation. An expired signature is never relabeled a confirmed failure. Keep RPC fallbacks on the same network and do not log request bodies, signed payloads or provider secrets.

After deployment, put a TLS reverse proxy in front, expose `/v1` on the same origin as the SPA, limit body sizes to256KiB and preserve network/epoch separation. The service has no administrative pause power over immutable guards; incident handling disables construction while retaining unresolved tracking.

The SDK exports strict amount conversion, generated ABI codecs, deployment checks, draft preparation, independent review verification, signing, exact submit and status observation. Use `ExitController` in asynchronous UIs to invalidate late prompts and stale work. Mainnet, fee bumps, address credentials, separate fee sources and nonstandard account signers are rejected in this release.

Export with `scripts/export_facet.py backend <empty-directory>` from the combined root. The extracted workspace builds the SDK first and has its own pnpm lockfile. Publishing SDK0.1.0 is a separate release action; no registry publication or repository push has occurred.

### Complete local testnet service

From the workspace root, `./scripts/pnpm --filter @mierkhat/backend local` starts persistent PostgreSQL on `127.0.0.1:55432` and the API on `127.0.0.1:3001`. The ignored `.tooling/local/config.json` contains generated database/encryption credentials with mode 0600. Production continues to use an external PostgreSQL service and environment configuration.

The enabled deployment is the actual pinned Stellar testnet vault, router, pairs and immutable guard. `reviewed` records the source/profile integration checks for this explicitly authorized testnet deployment; it does not claim an independent security audit. Mainnet remains disabled.

Live endpoints include `GET /v1/network`, `GET /v1/accounts/:owner`, `POST /v1/testnet/fund`, `POST /v1/testnet/faucet`, `POST /v1/setup/prepare`, `POST /v1/setup/submit`, and `POST /v1/exit/quote`. Setup requests carry a typed deposit or trustline draft. Both the browser and service verify exact contract arguments, token identities, owner, fees, bounds, nested transfers and wallet signatures. Signed setup bytes are encrypted and committed before a worker sends them. Guarded exits retain their separate strict root invocation policy.

The testnet issuer key is loaded only by the server from `TESTNET_FAUCET_KEY_FILE`, a local mode 0600 JSON file with an `admin` secret StrKey. The local launcher uses the existing dedicated testnet key source. Never commit that file. The issuer must match the public issuer in the pinned deployment. The faucet sends actual classic asset payments, 1000 of each configured token, at most once per account per 24 hours, with a global daily cap and serialized issuer sequence. Missing configuration disables issuance without exposing any secret to the browser.

`./scripts/pnpm --filter @mierkhat/sdk exec tsx scripts/testnet-journey.ts` runs the real funding, trustline, issuance, deposit and guarded exit journey against the local service and public testnet. It preserves private keys/exact retry bytes in ignored mode 0600 files and writes only public transaction evidence to `contracts/evidence/testnet-journey.json`. This is an actual ledger acceptance run, not a replacement RPC or wallet.

Restoration uses a separate typed `restore` setup draft and a single `RestoreFootprint` operation. The verifier allows only a subset of the deployment's fixed contract-instance and WASM-code keys, never arbitrary archive keys, transfers or mixed operations. The user reviews and signs its exact fee, then prepares a fresh action after confirmation. A genuine Freighter restoration transaction is recorded in the public journey evidence; the entries were live, so an archived-to-live transition is not claimed. Protocol 23 and later also support native invocation auto-restoration; normal guard fee/resource limits and executable checks remain in force.

`WORKERS_ENABLED=0` is an operator-only maintenance switch used by the black box SIGKILL acceptance harness. It pauses worker sends; status lookup remains available. Leave it unset for normal use. `backend/scripts/testnet-crash.ts` runs its own isolated actual PostgreSQL and API processes, kills the accepted-before-send process, restarts it, and verifies an actual committed testnet transaction with the original hash.
