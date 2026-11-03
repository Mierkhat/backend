# CI/CD operations

Merging a reviewed pull request into `main` starts `Verify and release`. Frontend and backend automatically stage a production build at their existing Vercel projects after the required `CI` check succeeds. The release script tests the staged deployment before promoting it to the existing live domain. Contract merges validate reproducible WASM and evidence; they do not submit transactions or change onchain deployments.

| Repository | Validation | Production destination |
| --- | --- | --- |
| [frontend](https://github.com/Mierkhat/frontend) | Frozen install, runtime audit, build, app/copy/embed types, unit/copy checks, six disconnected Chromium checks, SDK provenance and deployment compatibility | `mierkhat`, https://mierkhat.vercel.app |
| [backend](https://github.com/Mierkhat/backend) | Frozen install, runtime audit, API/SDK builds and types, unit tests, actual PostgreSQL integration tests, deployment compatibility | `mierkhat-backend`, https://mierkhat-backend.vercel.app |
| [contracts](https://github.com/Mierkhat/contracts) | Checksum-pinned Stellar CLI, pinned upstream builds, locked Rust builds/tests, formatting, deployed WASM hashes, cross-repository compatibility | Validated contract artifacts; onchain release requires its own reviewed deployment |

Every repository also runs full-history Gitleaks and Actionlint with checksum-pinned binaries. Actions use full commit SHAs, checkout does not retain Git credentials, and the workflow token has read-only contents access. Pull requests never enter the production environment. GitHub secret scanning and push protection are enabled. `.gitleaksignore` lists only exact reviewed historical fingerprints for public contract addresses, authentication digests and ledger-key XDR; new findings still fail. CI and dependency changes are covered by CODEOWNERS. The planned branch policy requires an up-to-date passing `CI` check, review of the latest commit, resolved review conversations, and owner review for protected paths, with force pushes and branch deletion disabled. Its effective API state is recorded after validation. Dependabot checks action updates weekly; updates still need review and CI.

## Release configuration

`.github/production.json` pins the existing project ID, team ID and live hostname. It contains no credentials. The only deployment credential GitHub Actions needs is `VERCEL_TOKEN`, stored separately in each repository's **production environment**, scoped to that Vercel project. Production branch policies allow only `main`. No manual environment approval is imposed, so a passing merge deploys automatically.

This environment's Vercel app authentication can inspect and deploy both projects. It cannot create durable CI tokens: `/v3/user/tokens` returned HTTP 403, `Cannot create tokens for this app`. The Mierkhat organization also lacks the Vercel GitHub app, so Git linking returned HTTP 400. These provider restrictions are distinct from authentication. Create the project-scoped tokens in Vercel's token settings and save them directly in the respective GitHub production environments; never paste them into chat or source. Until those secrets exist, validation works and production jobs fail closed before uploading or moving a live alias. Installing a Git integration alone does not activate this Actions-based release workflow.

The pipeline intentionally builds production source at Vercel. CI does not pull the backend's database URL, encryption key, faucet key or scheduler capability onto a runner. Vercel receives an audited snapshot of tracked source from the exact tested commit; the build uses its existing production configuration. This also avoids adding production secrets to build artifacts. The staged production build is smoke-tested and promoted without rebuilding. No uploaded authentication state, environment files or private traces are retained as workflow artifacts.

## Release sequence and recovery

1. Application, security and compatibility jobs run without deployment credentials. `CI` fails if any job fails or is cancelled.
2. The production job runs only for a `main` push or a manual workflow dispatch on `main`, in a main-only environment. Production runs serialize and are never cancelled mid-release.
3. `scripts/release.py` checks that the checkout matches the event SHA and the repository's current `main`. A superseded commit is skipped.
4. The script copies only regular tracked files whose bytes match Git, rejecting symlinks, private tooling, environment files and databases. `.env.example` is the documented public template exception. Existing `.vercelignore` rules further limit uploads. Project linking metadata is generated locally from the pinned public IDs.
5. `vercel deploy --prod --skip-domain` builds a production deployment without moving the live alias. The deployment API must confirm the exact project, team, ready production status and release commit before testing.
6. Protected requests use `vercel curl` with existing Vercel authentication. Checks cover database readiness, exact enabled profiles, OpenAPI, unauthenticated scheduler rejection and JSON 404s. Frontend also checks SPA routes, script/style assets and the favicon. These tests never create or sign a transaction.
7. The script checks `main` again before `vercel promote`. If it changed, the staged build remains unpromoted and the newer run owns the next release. Finally the live alias must resolve to the same tested deployment ID and pass smoke checks.

A failed build or staged smoke test leaves the previous deployment live. A post-promotion failure marks the run failed and needs incident inspection; the script does not guess whether a database or network change makes rollback safe. Re-run `Verify and release` on `main` through the Actions page to retry the current head. Older workflow retries skip themselves when superseded.

For a confirmed application regression, inspect the deployment and use authenticated `vercel rollback <known-good-production-deployment>` in the linked project. Database changes are independent: preserve `PAYLOAD_KEY` and uncertain encrypted attempts, and never request new signatures for uncertain operations. Backend migrations run under the existing session advisory lock during startup. Migrations should remain additive and compatible with the previous deployment; review schema changes separately. `vercel promote` restores domain assignment after rollback, and every normal pipeline release explicitly promotes its tested production deployment. QStash, cron authentication and existing database settings stay in Vercel; the pipeline does not recreate them.

## Coordinating the three repositories

`.github/compatibility.json` stores immutable reviewed sibling commits rather than following mutable branches. Checks compare the frontend and backend deployment registries, forbid enabled mainnet profiles, bind enabled executable hashes and migration identities to contract evidence, and verify the frontend archive checksum, SDK source tree, app/embed dependency references and both generated ABIs. CI reads only public files from pinned commits and never needs a cross-repository write token.

For a contract or SDK interface update, validate and publish the contract evidence first, update the backend SDK and registry, then repack the frontend SDK from the reviewed backend tree. Update the archive manifest, both app/embed references, lockfile, local frontend registry and compatibility pins as one reviewed frontend change. Update sibling pins in the affected repositories to the intended reviewed release combination. Adding a profile or changing a generated ABI cannot silently pass using an old packed SDK. Backwards-compatible rollout planning is required because these repositories deploy independently; incompatible changes need a separately coordinated rollout. Current CI deliberately validates the approved release combination, rather than claiming that every repository `main` always represents one atomic release.

## Repeatable checks

```sh
./scripts/ci-security.sh
python3 scripts/check-compatibility.py
# From an independent checkout, to use local pinned Git objects offline:
python3 scripts/check-compatibility.py --siblings /path/to/independent/checkouts
# Frontend/backend release boundary tests:
python3 -m unittest discover -s scripts -p test_release.py
```

An operator can run `python3 scripts/release.py --local-auth` from the independent `main` checkout using existing Vercel CLI authentication and the exact GitHub repository/ref/SHA environment. This mode is rejected inside GitHub Actions and does not replace its environment secret.

Frontend additionally runs `pnpm exec playwright test --config playwright.ci.config.ts` after building. CI installs Chromium and its Ubuntu libraries; local environments can use the project's documented browser library setup. Browser smoke tests cover the disconnected wallet chooser, keyboard focus, three widths and two themes. They are separate from the previously recorded live Freighter, signed transaction and external security review acceptance. Mainnet stays disabled.
