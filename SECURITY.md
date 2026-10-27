# Security policy

The supported environment is Stellar testnet with the explicitly pinned profile. Mainnet is disabled. Source/integration verification and a `reviewed` flag are not an independent security audit. Testnet assets have no monetary value.

## Reporting

Contact the repository maintainers privately through GitHub's security advisory reporting when available. If a private reporting channel is unavailable, open an issue requesting private contact without including vulnerability details. Do not publish signing keys, live exploit steps against user accounts or sensitive transaction payloads.

Include the affected commit, component, prerequisites, expected behavior and a minimal reproduction using dedicated test accounts. Use public hashes and sanitized diagnostics. Maintainers have not committed to a response-time SLA or a bug bounty program.

## Scope

Relevant issues include authorization bypass, unexpected token movement, weakened deployment pins, replay, signing-policy changes, secret exposure and recovery that could result in duplicate actions. Preserve exact signed bytes for an uncertain submission; a provider timeout is not proof of failure. Failed contract conditions can still consume network fees.
