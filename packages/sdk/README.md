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

Bordrless takes the launch pool's LP fee (0.3%) and 25% of what a launch's rules collect on each
swap (the creator fee, holder rewards, and any cut your hook takes), in SOL; a config can never
change that. A hook that takes nothing and refuses nothing costs the trader nothing beyond the LP
fee.

### Who may upgrade your hook

A config naming a custom hook is refused on chain (`HookUpgradeable`) unless the hook is immutable,
or upgradeable only by Bordrless (Studio's upgrade key, or the protocol's): a token's hook can never
be swapped for other code by anyone else after launch. Make yours final before making the config:
`solana program set-upgrade-authority <program> --final`. `hookAuthorityProblem(await
fetchProgramUpgradeInfo(connection, hook))` says the same before you sign. `launch.createConfig`
passes the hook's ProgramData account for the program to check (0.4.0 and later).

### Listing a config on the marketplace

`launch.createListedConfig(creator, config, args, authorShareBps)` makes the same config, plus your
share of the creator fee (1 to 5,000 bps of it, fixed for ever) on every launch someone else makes
from it. Claims split it automatically: the creator's `launch.claimCreatorFees(creator, mint, quote,
{ config, author })`, or yours, `launch.claimAuthorFees(author, mint, quote, config, creator)`. The
`ConfigListed` and `AuthorFeesPaid` events record both.

## Companions: reward tokens without a keeper (0.5.0 and later)

A companion is a Bordrless program that is a launch's creator, so every creator fee lands with it
and only its code spends it: bought back and burned, streamed to holders, or paid to the launcher,
with a dev buy that vests. Every step is permissionless and pays its sender a small bounty.

```ts
import { companion, COMPANION_DEFAULTS, COMPANION_TEMPLATES } from '@bordrless/sdk';

const args = { ...COMPANION_DEFAULTS, split: COMPANION_TEMPLATES.buysItself, vestSecs: 0, fund };
companion.create(payer, beneficiary, mint, args);              // the mint signs
companion.launch(launcher, mint, createLaunchIx, launchArgs);   // the launch, made by the companion
companion.claimFees(cranker, mint);                              // then any of these, by anyone
companion.buyback(cranker, launchKeys, rewards);
companion.share(cranker, mint);
companion.withdraw(sender, mint, beneficiary);
companion.release(cranker, launchKeys, rewards, beneficiary);
```

A companion launch needs the protocol lookup table's 22 addresses (`companionReady(table)`). The
design, its limits and what it refuses:
[docs/companions.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/companions.md).

## Lottery coins: companion v2 (0.6.0 and later)

A companion can now run a game. A share of every fee claim fills a pot held by the companion; each
round a draw (ORAO VRF) picks a holder, weighted by the tokens they hold, and the companion pays
the prize as SOL. The coin's token hook is Bordrless's lottery hook
(`HqFWsCBQ416DAfevJ9TspyT5yXGGoYTCpcreiGkCgWcr`), which gives holders ticket ranges each round.

```ts
import { companion, lotteryHook, findWinningHolding, fetchSeedSlot } from '@bordrless/sdk';

// before the launch, signed by the mint: companion.create → lotteryHook.prepare → companion.createGame
lotteryHook.enter(mint, owner);                       // a holder registers their tickets for the round
companion.draw(cranker, mint, hook, round, await fetchSeedSlot(connection), treasury, paidSeed);
companion.reveal(cranker, mint, hook, request);       // once ORAO answers
companion.claimPrize(cranker, mint, hook, attempt, winnerHolding);
```

Every step is permissionless. Until a game's hook is audited, its pot is capped at 10 SOL; a game
the protocol blocks has its pot bought back and burned, paying no one. The draw is verifiable, not
"provably fair": ORAO's signers are trusted to answer. The design, the keeper's loop and every rule:
[docs/games.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/games.md).

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
