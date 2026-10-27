# Contributing

Read the [README](README.md) for the pinned toolchain and verification commands. Open an issue describing the problem or intended behavior before a substantial change, then submit a focused pull request against `main`.

## Changes and verification

Explain what changes for the user, why it is needed and how it was checked. Run the relevant build, type and test checks from the README. Add meaningful coverage for changed behavior. Preserve exact amount handling, deployment pins, wallet verification and uncertain-result recovery. Never replace live runtime data with examples or silently weaken signing policy.

Use the actual Stellar testnet for network acceptance. Keep assertions based on ledger evidence; distinguish unit/host tests, real network observations and independent review. Mainnet remains disabled. Contract or SDK changes can require coordinated updates in the [frontend](https://github.com/Mierkhat/frontend), [backend](https://github.com/Mierkhat/backend) and [contracts](https://github.com/Mierkhat/contracts) repositories.

## Files and credentials

Do not commit `.env`, wallet seeds, issuer keys, signed envelopes, databases, browser profiles, dependency directories or build output. Include only public transaction evidence. Keep third-party license text and provenance intact. Contributions to Mierkhat-authored code use the repository's [MIT license](LICENSE).

Report security issues through the [security policy](SECURITY.md), rather than posting exploit details in a public issue.
