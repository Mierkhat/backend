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
| `WORKERS_ENABLED` | Leave enabled; `0` pauses worker sends for maintenance |

Generate the encryption key with `openssl rand -hex 32`. Back it up securely with the database and preserve it across restarts. Replacing it while unresolved payloads exist prevents their decryption. It must never appear in browser configuration or logs.

`pnpm local` creates persistent storage/random credentials in this standalone checkout's ignored `.tooling/local/`. The original combined workspace retains its root storage. Embedded PostgreSQL needs a non-root Linux user. Production should use external PostgreSQL and the built server.

## Testnet issuer

Configure the real issuer matching the pinned assets. No key is shipped; missing configuration disables issuance. The faucet serializes the issuer sequence, makes actual classic asset payments, allows one allocation of each configured token per account per 24 hours and enforces a daily global cap. Friendbot native funding is separate. Never configure a personal wallet as the issuer.

## Hosting

Install the frozen lockfile and run `pnpm build`. Put TLS in front and expose `/v1` on the frontend's origin. Preserve the 256 KiB request limit, restrict origins and reject client-selected RPC targets. Set `HOST` for container networking where necessary. `/v1/health` checks database access; `/v1/openapi.json` provides current schemas. SIGTERM waits for active reconciliation and closes database connections.

## Recovery and retention

Encrypted signed payloads and idempotency keys expire after 24 hours. Terminal evidence immediately removes signed bytes. Unsigned reviews are pruned 24 hours after expiry. Terminal tracking is retained for 90 days; unresolved public hashes remain for reconciliation. Expired signatures are not proof of prior failure.

Restart with the same database, payload key and registry so workers can resume exact attempts. Do not request a replacement signature while the original remains uncertain. Disabling construction does not pause an immutable on-chain guard. New profiles need verified pins, client authorization and their own acceptance evidence. Mainnet remains disabled.
