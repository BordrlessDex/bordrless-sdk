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

## Use

```ts
import { PROGRAM_IDS, FIXED_ADDRESSES, TOKEN_HOOK_FLAGS, POOL_HOOK_FLAGS, RULE_BOUNDS } from '@bordrless/shared';

PROGRAM_IDS.token; // the token program (devnet and localnet; mainnet gets its own keys at deploy time)
TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA;
```

## Where to read more

- The SDK page: https://bordrless.app/sdk
- The standard in full: https://bordrless.app/docs

Status: the programs run on localnet and devnet until they are deployed to mainnet; they keep an
upgrade authority until audited.
