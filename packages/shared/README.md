# @bordrless/shared

The parts of Bordrless that both the programs' clients and the site agree on, with no Solana
dependencies: the program ids and every fixed address (`PROGRAM_IDS`, `HOOK_SIGNERS`,
`FIXED_ADDRESSES`, the protocol lookup table), the hook flags (`TOKEN_HOOK_FLAGS`,
`POOL_HOOK_FLAGS`), the launch-rule policy (the same math as the on-chain `bordrless-core` crate:
bounds, presets, fee compounding, the kit's 64-byte layout) and the API types the backend serves.

Bordrless is a token standard of its own on Solana, not Token-2022 and not SPL: tokens live in a
program built for hooks, and a hook answers (cuts, a burn, a swap's fee, 64 bytes of state per
holding) instead of only approving. `@bordrless/sdk` builds on this package.

## Install

```sh
npm install @bordrless/shared
```

npm has 0.14.0. 0.15.0 to 0.17.0 (the 5% fee cap, `fees.ts`, the keeper.json fields, `agent.ts`,
`rates.ts`) are GitHub releases of BordrlessDex/bordrless-sdk until they reach npm: build from a
clone at the tag.

## Use

```ts
import { PROGRAM_IDS, FIXED_ADDRESSES, TOKEN_HOOK_FLAGS, POOL_HOOK_FLAGS, RULE_BOUNDS } from '@bordrless/shared';

PROGRAM_IDS.token; // the token program (one set of ids on every cluster)
TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA;
```

A hook of your own launches from a config only when nobody outside Bordrless can upgrade it:
immutable, or held by one of `HOOK_UPGRADE_AUTHORITIES` (Bordrless Studio's key or the protocol's),
as the launch program checks. `hookFinalCommand(programId)` gives the `solana program
set-upgrade-authority --final` command that makes it immutable after deploying, and
`hookAuthorityAccepted` is the same check off chain.

## Where to read more

- The SDK page: https://bordrless.app/sdk
- The standard in full: https://bordrless.app/docs

Status: the programs are live on mainnet; they keep an upgrade authority until audited.
