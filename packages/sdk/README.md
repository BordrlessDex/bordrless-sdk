# @bordrless/sdk

The TypeScript client of the Bordrless programs, built on their IDLs: addresses and every PDA,
account and event decoding, instruction builders for every program (token, DEX, bridge, launchpad,
kit), the resolution of a hook's extra accounts, and v0 transactions with the protocol lookup
table.

Bordrless is a token standard of its own on Solana, not Token-2022 and not SPL: tokens live in a
program built for hooks. A hook runs before and after every transfer, mint and burn (and, for a
pool hook, on every swap on the Bordrless DEX) and answers: up to three cuts from the amount, a burn
and the swap's fee on a swap, 64 bytes of state in every holding. A hook never gets the user's
signature; it answers, and the token program or the DEX applies the answer. The hook interface is
open ([`crates/bordrless-hook`](https://github.com/BordrlessDex/bordrless-programs/tree/main/crates/bordrless-hook)): write a hook with whatever rules you want and put it on a mint
you create with this SDK.

## Install

```sh
npm install @bordrless/sdk @bordrless/shared
```

Peer requirements: `@solana/web3.js` 1.x (a dependency), Node 20 or later or a bundler.

## Use

```ts
import {
  token, swap, bridge, launch, kit,           // instruction builders, one object per program
  holdingAddress, poolAddress, launchAddress,  // every PDA
  decodeMint, decodeHolding, decodePool,       // typed accounts from the IDL coders
  eventsOf, typedEvent,                        // events from a transaction's inner instructions
  fetchTokenHook, kitTokenHook,                // a hook's accounts, resolved for one operation
  buildV0Transaction, protocolLookupTable,     // v0 transactions with the protocol table
  explainFailure,                              // a failed transaction, in words
} from '@bordrless/sdk';
import { TOKEN_HOOK_FLAGS } from '@bordrless/shared';

// A mint with a hook of your own, named at creation and locked by revoking the hook authority.
const create = token.createMint(creator, mint.publicKey, {
  decimals: 6, name: 'My token', symbol: 'MINE', uri: 'ipfs://…', maxSupply: 1_000_000_000_000_000n,
  mintAuthority: creator, freezeAuthority: null,
  hookProgram: myHookProgram, hookFlags: TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA,
  hookAuthority: creator, metadataAuthority: creator,
});
const lock = token.setAuthority(creator, mint.publicKey, 'hook', null);

// A transfer of a hooked mint carries the hook's accounts, resolved for that transfer.
const hook = await fetchTokenHook(connection, { mint: mint.publicKey, source, destination, authority });
const send = token.transfer(authority, source, destination, mint.publicKey, 1_000_000n, hook);
```

## Build your own: a launch with a hook you wrote

A launch on the site can run a token hook of your own instead of the kit ([docs/hooks-v2.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/hooks-v2.md) §5.7,
§5.8). The rules travel in a `LaunchConfig`, an account anyone makes once and reuses; its key is
what the launch page takes under "Build your own". The site labels such a token "Custom hook,
unverified": nobody vets the code.

1. **Write the hook** against [`crates/bordrless-hook`](https://github.com/BordrlessDex/bordrless-programs/tree/main/crates/bordrless-hook) and deploy it. [`programs/tax_hook`](https://github.com/BordrlessDex/bordrless-programs/tree/main/programs/tax_hook) is the
   worked example (a cut of every transfer to a collector).
2. **Prepare it for the mint.** The launch creates the mint, so the hook must already have its
   registry at `["bordrless-hook-accounts", mint]` for the mint address the launch page shows
   (`tax_hook.prepare` does this; a hook of your own needs an instruction like it). The registry
   must not depend on who sends or receives: the launch passes one slice for every transfer.
3. **Make the config** and share its key.
4. **Paste the key** into the launch page. It reads the config, shows every rule and the hook,
   checks the registry for the mint, and launches with it.

```ts
import { Keypair } from '@solana/web3.js';
import { buildCreateConfig, inspectConfig, taxHook, TAX_HOOK_FLAGS, TAX_HOOK_PROGRAM, NO_LAUNCH_RULES } from '@bordrless/sdk';

// 2. The mint address comes from the launch page ("Build your own" shows it); prepare the hook for it.
const prepare = taxHook.prepare(me, mint, collector, 100, 0); // 1% of every transfer to `collector`

// 3. A config: burn and the creator fee are pool-hook rules and may go with a custom hook; the kit's rules may not.
const made = buildCreateConfig(me, {
  rules: { ...NO_LAUNCH_RULES, burnBuyBps: 25, burnSellBps: 25 },
  creatorFeeBps: 100,
  customHook: TAX_HOOK_PROGRAM,
  customHookFlags: TAX_HOOK_FLAGS,
  label: 'taxed',
});
// send `made.instruction` signed by `me` and `made.keypair`; then paste `made.address` into the launch page.

// What the page will say about it, the same checks:
const seen = await inspectConfig(connection, made.address, mint); // { config, problems: [], hook: { upgradeAuthority }, registryReady: true }
```

Bordrless takes 25% of what a launch's rules collect on each swap (the creator fee, holder
rewards, and any cut your hook takes), in SOL; a config can never change that. A hook that takes
nothing and refuses nothing costs the trader nothing beyond the pool fee.

## Where to read more

- The SDK page, with the hook interface and the examples: https://bordrless.app/sdk
- The standard in full: https://bordrless.app/docs

## Integrating: terminals, indexers, wallets

[`docs/integration`](https://github.com/BordrlessDex/bordrless-sdk/tree/main/docs/integration) walks
through reading tokens and prices, indexing trades, quoting and building swaps, hooks and the
bridge, with runnable examples in [`examples/`](https://github.com/BordrlessDex/bordrless-sdk/tree/main/examples).

Status: the programs are live on Solana mainnet-beta at the addresses in `PROGRAM_IDS` (the same
ids on devnet and localnet), verified builds of
[bordrless-programs](https://github.com/BordrlessDex/bordrless-programs). They keep an upgrade
authority until audited.
