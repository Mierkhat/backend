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
