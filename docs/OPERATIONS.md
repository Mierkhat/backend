# Operations

## Environment

`pnpm dev` and `pnpm start` load `.env`. Keep credentials outside version control.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL |
| `PAYLOAD_KEY` | Required 32-byte encryption key as 64 hex characters |
| `POSTGRES_PASSWORD` | Password for the provided Compose service |
| `ALLOWED_ORIGINS` | Comma-separated origins; defaults to localhost:5173 |
| `TESTNET_RPC_URLS` | Fixed trusted testnet RPC endpoints |
| `LOCAL_RPC_URLS` | Endpoints for explicitly configured local-network profiles |
| `DEPLOYMENT_REGISTRY` | Optional absolute deployment-registry path |
| `HOST` / `PORT` | Listen address; defaults to 127.0.0.1:3001 |
| `TESTNET_FAUCET_KEY_FILE` | Optional server-only mode-0600 issuer JSON file with `admin` |
| `TESTNET_FAUCET_SECRET` | Optional server-only dedicated testnet issuer key; takes precedence over the file |
| `CRON_SECRET` | Dedicated bearer capability for the authenticated scheduled job endpoint |
| `WORKERS_ENABLED` | Leave enabled; `0` pauses worker sends for maintenance |

Generate the encryption key with `openssl rand -hex 32`. Back it up securely with the database and preserve it across restarts. Replacing it while unresolved payloads exist prevents their decryption. It must never appear in browser configuration or logs.

`pnpm local` creates persistent storage/random credentials in this standalone checkout's ignored `.tooling/local/`. The original combined workspace retains its root storage. Embedded PostgreSQL needs a non-root Linux user. Production should use external PostgreSQL and the built server.

## Testnet issuer

Configure the real issuer matching the pinned assets. No key is shipped; missing configuration disables issuance. The faucet serializes the issuer sequence, makes actual classic asset payments, allows one allocation of each configured token per account per 24 hours and enforces a daily global cap. Friendbot native funding is separate. Never configure a personal wallet as the issuer.

## Hosting

Install the frozen lockfile and run `pnpm build`. Put TLS in front and expose `/v1` on the frontend's origin. Preserve the 256 KiB request limit, restrict origins and reject client-selected RPC targets. Set `HOST` for container networking where necessary. `/v1/health` checks database access; `/v1/openapi.json` provides current schemas. SIGTERM waits for active reconciliation and closes database connections.

## Vercel

`vercel.json` deploys the Node adapter in `api/index.js`; `/v1` requests reach the same Fastify routes and retain the 256 KiB body limit. Vercel provides TLS and trusted forwarding headers. The adapter uses a three-connection PostgreSQL pool attached to the function lifecycle. Configure a separate production database, the existing registry, `PAYLOAD_KEY`, `ALLOWED_ORIGINS=https://mierkhat.vercel.app` and the optional dedicated issuer secret in backend environment variables only. Use a direct PostgreSQL URL for session advisory locks during migrations. Build before running `pnpm typecheck:api`.

Vercel mode starts no permanent timer or listener. Submissions, transaction lookups and watch requests schedule a shared background window of four leased cycles, fifteen seconds apart. The existing database claims and compare-and-set updates still control exact retries. The authenticated `/v1/internal/run` GET/POST route runs the same bounded work and retention pruning. It rejects every request unless its bearer token matches `CRON_SECRET`.

The checked-in daily Vercel cron provides retention housekeeping on Hobby. Provision a dedicated free Upstash QStash scheduler and call the internal endpoint every two minutes for unattended reconciliation and watch checks; forward the dedicated bearer capability and keep retries bounded. Hobby cron alone does not provide frequent unattended checks. No scheduler signs transactions or obtains a user's wallet key. The ordinary standalone server retains its one-second workers, periodic pruning and graceful shutdown.

## Recovery and retention

Encrypted signed payloads and idempotency keys expire after 24 hours. Terminal evidence immediately removes signed bytes. Unsigned reviews are pruned 24 hours after expiry. Terminal tracking is retained for 90 days; unresolved public hashes remain for reconciliation. Expired signatures are not proof of prior failure.

Restart with the same database, payload key and registry so workers can resume exact attempts. Do not request a replacement signature while the original remains uncertain. Disabling construction does not pause an immutable on-chain guard. New profiles need verified pins, client authorization and their own acceptance evidence. Mainnet remains disabled.
