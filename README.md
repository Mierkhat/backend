# Mierkhat backend and SDK

[![Verify](https://github.com/Mierkhat/backend/actions/workflows/verify.yml/badge.svg)](https://github.com/Mierkhat/backend/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Mierkhat prepares and tracks vault withdrawals on Stellar testnet. Users choose the shares to spend and minimum settlement tokens to receive, review the transaction and sign with their own wallet. The immutable [guard](https://github.com/Mierkhat/contracts) enforces the withdrawal and direct swaps in one invocation.

This repository contains the Fastify API, PostgreSQL persistence, recovery workers and `@mierkhat/sdk`. The service never holds user wallet signing keys. It verifies signed transactions, stores exact retry bytes encrypted before sending them, and reconciles uncertain results by public transaction hash.

## Stack

| Component            | Technology                                      |
| -------------------- | ----------------------------------------------- |
| Language and runtime | TypeScript 7.0.2, Node.js 24.22.1               |
| HTTP and validation  | Fastify 5.12.7, Zod 4.6.7                       |
| Persistence          | PostgreSQL 17.6, pg 8.23.1                      |
| Stellar              | Stellar SDK 17.4.0, Soroban RPC, Horizon        |
| Local database       | embedded-postgres 17.6.0-beta.15                |
| Verification         | Vitest 5.0.5, real PostgreSQL integration tests |
| Package manager      | pnpm 12.15.0                                    |

## Quick start

Use Linux x64 as a non-root user for the embedded database. Install Node.js 24.22.1, then:

```sh
git clone https://github.com/Mierkhat/backend.git
cd backend
npm install --global pnpm@12.15.0
pnpm install --frozen-lockfile
pnpm build
pnpm local
```

The local launcher starts persistent PostgreSQL on `127.0.0.1:55432`, applies migrations and starts the API on `127.0.0.1:3001`. Random database/encryption credentials stay in ignored `.tooling/local/` files. Preserve that directory to resume outstanding submissions after a restart.

```sh
curl --fail http://127.0.0.1:3001/v1/health
curl --fail http://127.0.0.1:3001/v1/openapi.json
```

Run the [frontend](https://github.com/Mierkhat/frontend#quick-start) separately. The bundled registry enables six withdrawal output profiles and two cross-asset migration profiles across two actual testnet vaults. Readiness and receiving-target planning test complete invocations; opt-in condition watches persist in PostgreSQL and deliver in-app notifications. See [withdrawal tools](docs/EXIT_TOOLS.md). Account positions are grouped once per vault; quote and setup requests can select a route by epoch. Mainnet is disabled. No real balances or RPC responses are replaced with examples.

Account funding uses Friendbot. Issuing configured test tokens additionally requires `TESTNET_FAUCET_KEY_FILE`, pointing to a mode-0600 JSON file containing the dedicated issuer's `admin` secret. Its issuer must match the pinned assets. A fresh clone does not include this credential; without it, issuance reports unavailability. Never use a personal wallet secret for the faucet. Testnet assets have no monetary value.

## External PostgreSQL

```sh
cp .env.example .env
openssl rand -hex 32
```

Set `POSTGRES_PASSWORD`, the matching `DATABASE_URL` and the generated `PAYLOAD_KEY` in `.env`. Keep `PAYLOAD_KEY` stable across restarts. Then:

```sh
docker compose up -d
pnpm dev
# Or, after pnpm build:
pnpm start
```

The server reads `.env` and serializes migrations with an advisory lock. See [operations](docs/OPERATIONS.md) for deployment, recovery, retention and issuer configuration.

## Verification

```sh
pnpm build
pnpm typecheck
pnpm typecheck:scripts
pnpm --filter @mierkhat/sdk typecheck
pnpm --filter @mierkhat/sdk typecheck:scripts
pnpm test                         # 4 provider tests
pnpm --filter @mierkhat/sdk test   # 37 SDK tests
pnpm test:integration             # 16 real PostgreSQL tests
pnpm --filter @mierkhat/sdk check:deployments
```

Integration tests create a temporary real PostgreSQL cluster with a random password, then remove it. They cover encrypted bytes, deduplication, idempotency conflicts, worker leases, terminal updates, expiry, route selection and receipt enrichment. They do not broadcast transactions. Actual testnet acceptance has separate [integration instructions](docs/INTEGRATION.md).

## Repository layout

```text
src/          HTTP service, transaction checks, storage and workers
migrations/   Ordered PostgreSQL schema migrations
sdk/          Transaction preparation, verification, signing and recovery
scripts/      Persistent local service and crash acceptance harness
test/         Actual PostgreSQL integration tests
docs/         API, architecture, operations and integration documentation
compose.yaml  Pinned local PostgreSQL service
```

## Documentation

- [Architecture and recovery](docs/ARCHITECTURE.md)
- [HTTP API and SDK](docs/API.md), [OpenAPI snapshot](docs/openapi.json)
- [Operations and configuration](docs/OPERATIONS.md)
- [Integration testing and sibling checkouts](docs/INTEGRATION.md)
- [Frontend](https://github.com/Mierkhat/frontend) and [contracts](https://github.com/Mierkhat/contracts)

The SDK is a local workspace package; no npm release is needed. Ordinary owner-signed accounts are supported. Mainnet, fee bumps, separate fee sources and nonstandard signers are rejected. `reviewed` denotes source/integration verification, not an independent audit.

## Combined workspace

In the original combined workspace, run `./scripts/pnpm --filter @mierkhat/backend <command>` from its root. The local launcher retains that workspace's root `.tooling/local/` storage. Standalone clones use this repository's `.tooling/local/`.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report sensitive issues through the [security policy](SECURITY.md).

## License

Mierkhat-authored code uses the [MIT license](LICENSE). Dependencies, upstream protocols, fonts where bundled and brand usage retain the terms described in [third-party notices](THIRD_PARTY_NOTICES.md).
