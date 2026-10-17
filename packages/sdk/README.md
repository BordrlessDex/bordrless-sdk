# @bordrless/sdk

The TypeScript client of the Bordrless programs, built on their IDLs: addresses and every PDA,
account and event decoding, instruction builders for every program (token, DEX, bridge, launchpad,
kit, the companion program with its games, Snowball, scripts and approvals), the resolution of a
hook's extra accounts, v0 transactions with the protocol lookup table, balance changes for
integrators, and the `bordrless` CLI (a market maker, and the open deploy commands for a hook or a
strategy). Builders working from their own terminal: "Hooks, companions and pairs from your own
terminal", below.

Bordrless is a token standard of its own on Solana, not Token-2022 and not SPL: tokens live in a
program built for hooks. A hook runs before and after every transfer, mint and burn (and, for a
pool hook, on every swap on the Bordrless DEX) and answers: up to three cuts from the amount, a burn
and the swap's fee on a swap, 64 bytes of state in every holding. A hook never gets the user's
signature; it answers, and the token program or the DEX applies the answer. The hook interface is
open ([`crates/bordrless-hook`](https://github.com/BordrlessDex/bordrless-programs/tree/main/crates/bordrless-hook)), and so are the programs: `create_mint`,
`create_pool` and the bridge's `register` take instructions from anyone. Write a hook with whatever
rules you want and put it on a mint you create; open a pool for any pair, or a bonding curve a
program of your own opens as its pool hook; bring your own quote asset in. None of it goes through
Bordrless's launchpad (https://bordrless.app/docs/build).

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

## Build your own

Anything on the standard, not only a hook for Bordrless's launchpad. What each layer takes from
anyone, what it costs, what stays Bordrless's (the launchpad, the kit, the companion program, the
Workshop, Half-Life), the CPI and transaction budgets and the trust facts are on one page:
https://bordrless.app/docs/build.

- **A token:** `token.createMint` (above), with any hook program and the four authorities; revoke
  the hook authority to fix which program runs. A hook that keeps per-mint state prepares its
  registry at `registryAddress(hook, mint)` before the first transfer.
- **A hook:** an ordinary program against `crates/bordrless-hook`; `programs/tax_hook` is the
  worked example that fits a mint you create (the kit does not: it accepts only the launchpad).
- **A pool, a launchpad:** below.
- **A quote asset:** `bridge.register(payer, underlying, underlyingProgram, { name, symbol, uri })`,
  once per underlying mint, then `bridge.wrap` and `bridge.unwrap` one for one.

### Your own pools and curves

`swap.createPool` is permissionless for an ordinary pool: any two mints of the standard, any LP fee
from 0 to 9,000 bps, with or without a pool hook. A bonding curve (virtual reserves) is opened only
by its hook program, signing with `hookAuthority(program)` (its `["hook-authority"]` PDA), and
graduated by the same signer with `swap.finalizeCurve`. A pool you open pays the DEX's protocol fee
(`protocolFeeBps` of the quote side, as the config sets it when the pool is created) and keeps every
cut its hook takes; the share model (the LP fee and a quarter of the cuts to Bordrless) applies only
to the curves the launchpad opens.

A buy past the end of a **launch's** curve is filled ([docs/hooks-v2.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/hooks-v2.md) §3.1): the
launchpad's `before_swap` ends its answer with the part of the input to use, the DEX uses that much,
takes every token the curve has left and leaves the rest with the trader, holding `minAmountOut` to
pro rata, so a buy of more than the curve has left buys the rest and graduates it; `curveFillBuy`
in `@bordrless/shared` says the part a launch would use, and a quote's `amountUsed` carries it. A
curve your own program opens is not filled: the DEX refuses a fill from any hook but the
launchpad's (`BadFill`), since a hook could otherwise keep a buyer's whole input for the last
tokens; a buy past its end fails as it always has.

```ts
import { PublicKey } from '@solana/web3.js';
import { POOL_HOOK_FLAGS } from '@bordrless/shared';
import { BRIDGED_SOL_MINT, SWAP_CONFIG, decodeSwapConfig, fetchAccount, holdingAddress, hookAuthority, lpMintAddress, poolAddress, registryAddress, swap } from '@bordrless/sdk';

const MY_CURVE = new PublicKey('…');                        // your deployed pool hook

// 1. An ordinary pool: anyone, any two mints of the standard, any LP fee from 0 to 9,000 bps. Base and quote
//    come from the authority's holdings; the LP goes to its LP holding. The protocol fee is the config's.
const config = (await fetchAccount(connection, SWAP_CONFIG, decodeSwapConfig))!;
const plain = swap.createPool(me, me, config.treasury, mint, BRIDGED_SOL_MINT, {
  lpFeeBps: 100,
  hookProgram: null, hookFlags: 0,
  virtualBase: 0n, virtualQuote: 0n,                        // zero: not a curve
  baseAmount: 500_000_000_000n, quoteAmount: 10_000_000_000n,
  baseHookAccounts: 0, quoteHookAccounts: 0,                // a hooked base passes its token-hook slice in extras
  hookData: new Uint8Array(),
});

// 2. A bonding curve is a pool with virtual reserves, and only its hook program may open one: the DEX wants the
//    hook's ["hook-authority"] PDA as a signer (CurveNeedsHook otherwise), so this instruction is what your
//    program sends by CPI, invoke_signed for the caller and for the authority that holds the supply.
const caller = hookAuthority(MY_CURVE);                     // PDA(["hook-authority"], MY_CURVE)
const vault = new PublicKey('…');                           // your program's PDA that owns the base supply
const pool = poolAddress(mint, BRIDGED_SOL_MINT, 30, MY_CURVE);
const registry = registryAddress(MY_CURVE, pool);           // ["bordrless-hook-accounts", pool]: write it first if your callbacks need extras
const curve = swap.createPool(me, vault, config.treasury, mint, BRIDGED_SOL_MINT, {
  lpFeeBps: 30,
  hookProgram: MY_CURVE,
  hookFlags: POOL_HOOK_FLAGS.BEFORE_SWAP | POOL_HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA,
  virtualBase: 0n, virtualQuote: 30_000_000_000n,           // the curve's offset
  baseAmount: 1_000_000_000_000n, quoteAmount: 0n,          // a curve deposits base only
  baseHookAccounts: 0, quoteHookAccounts: 0,
  hookData: new Uint8Array(),
}, extras, caller);
// Your hook gets no initialize callbacks for a pool it opens itself; before_swap and after_swap run on every trade.

// 3. Graduation: your program's own instruction CPIs finalize_curve with the same PDA signing. The virtual
//    reserves go, the real ones stay, and the first LP is minted to the holding you name. Liquidity is locked
//    (CurveLocked) until then.
const [, bump] = PublicKey.findProgramAddressSync([Buffer.from('hook-authority')], MY_CURVE);
const graduate = swap.finalizeCurve(caller, bump, pool, mint, BRIDGED_SOL_MINT, holdingAddress(lpMintAddress(pool), vault));
```

### A launch on Bordrless's launchpad with a hook you wrote

A launch on the site can run a token hook of your own instead of the kit ([docs/hooks-v2.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/hooks-v2.md) §5.7,
§5.8). The rules travel in a `LaunchConfig`, an account anyone makes once and reuses; its key is
what the launch page takes under "Custom config". A hook you deployed yourself was not read by
Bordrless: the site shows such a token's hook as a custom hook written by its creator, with who can
upgrade it, and no reading (a Workshop hook shows Bordrless's reading of it instead).

> **Nobody outside Bordrless may be able to upgrade the hook.** The launch program's
> `create_config` refuses (`HookUpgradeable`) a hook whose upgrade authority is anyone but no one
> (immutable), its own `hook_timelock` (a public delay of 3 days or more), the Workshop's upgrade
> key `CS1NRyXNCPxEUP4CRoa26cHQSeSJCxXh5SPijwFhDW6W` (`STUDIO_UPGRADE_AUTHORITY`) or the protocol's
> `5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd` (`HOOK_UPGRADE_AUTHORITIES` in
> `@bordrless/shared`). The site holds older configs to the same rule: the launch page says "This
> config's hook can be upgraded by someone outside Bordrless, so it can't launch here." and the API
> answers 400 `hook_upgrade_authority`. Make your hook immutable right after deploying, signed by
> its current upgrade authority:
>
> ```sh
> solana program set-upgrade-authority <PROGRAM_ID> --final
> ```
>
> Hooks deployed through the Workshop are held by its key, which Bordrless holds and the builder
> never does.

1. **Write the hook** against [`crates/bordrless-hook`](https://github.com/BordrlessDex/bordrless-programs/tree/main/crates/bordrless-hook) and deploy it. [`programs/tax_hook`](https://github.com/BordrlessDex/bordrless-programs/tree/main/programs/tax_hook) is the
   worked example (a cut of every transfer to a collector); the Workshop's template
   (`tools/studio-builder/template` in the monorepo, the hook brief on https://bordrless.app/sdk/build)
   is the shape the Workshop checks.
2. **Make it immutable** with the command above.
3. **Prepare it for the mint.** The launch creates the mint, so the hook must already have its
   registry at `["bordrless-hook-accounts", mint]` for the mint address the launch page shows
   (`tax_hook.prepare` does this; a hook on the Workshop template has the standard `prepare`,
   which `templateHook.prepare(hook, payer, mint)` builds; a hook of your own needs an
   instruction like it). The registry must not depend on who sends or receives: the launch passes
   one slice for every transfer.
4. **Make the config** (`buildCreateConfig`; `buildCreateListedConfig` with an author share, which
   pays you that share of the creator fee, at most half, of every launch someone else makes from
   it) and share its key. A
   Workshop hook's builder can make it here too: once a launch uses it, the Workshop adopts it and
   offers the hook on the launch page.
5. **Paste the key** into the launch page. It reads the config, shows every rule and the hook,
   checks who can upgrade the hook and the registry for the mint, and launches with it.

```ts
import { Keypair } from '@solana/web3.js';
import { buildCreateConfig, inspectConfig, taxHook, TAX_HOOK_FLAGS, TAX_HOOK_PROGRAM, NO_LAUNCH_RULES } from '@bordrless/sdk';

// 3. The mint address comes from the launch page ("Build your own" shows it); prepare the hook for it.
const prepare = taxHook.prepare(me, mint, collector, 100, 0); // 1% of every transfer to `collector`

// 4. A config: burn and the creator fee are pool-hook rules and may go with a custom hook; the kit's rules may not.
const made = buildCreateConfig(me, {
  rules: { ...NO_LAUNCH_RULES, burnBuyBps: 25, burnSellBps: 25 },
  creatorFeeBps: 100,
  customHook: TAX_HOOK_PROGRAM,
  customHookFlags: TAX_HOOK_FLAGS,
  label: 'taxed',
});
// send `made.instruction` signed by `me` and `made.keypair`; then paste `made.address` into the launch page.

// What the page will say about it, the same checks (who can upgrade the hook included):
const seen = await inspectConfig(connection, made.address, mint); // { config, problems: [], hook: { upgradeAuthority }, hookAccepted: true, registryReady: true }
```

Bordrless takes 25% of what a launch's rules collect on each swap (the creator fee, holder
rewards, and any cut your hook takes), in SOL; a config can never change that. A hook that takes
nothing and refuses nothing costs the trader nothing beyond the pool fee.

## Earning from launches and trades: partner configs, the router, payees

Three ways for an app, a service or a team to be paid by Bordrless's programs, all in SOL, none
needing a hook of your own (13 Oct 2026, live on mainnet).

**A partner config** (`docs/partner-fee.md` in bordrless-programs; 0.11.0). A launch config that
names your wallet and its share of the creator fee, 1% to 100% of it (what is left after
Bordrless's quarter), fixed for ever, Meteora-style. Every coin launched from it, whoever launches
it (your own site through the SDK, or the launch page with `?config=<address>`), pays you that
share of every claim. It can carry any custom hook the launchpad accepts and an author's share too (at most 100%
in all). Anyone may pay a coin's fees out at any time, every party at once to its own holding, so
you collect whenever you like. The launchpad allows a creator fee of up to 10%. A companion coin
can't launch from a partner config (`PartnerOnCompanion`): share a companion's part with payees.

```ts
import { BRIDGED_SOL_MINT, NO_LAUNCH_RULES, buildCreatePartnerConfig, decodeLaunch, launch, launchAddress, partnerOf, token } from '@bordrless/sdk';

// Once: a 1% creator fee, all of it (after Bordrless's share) to your wallet.
const made = buildCreatePartnerConfig(me, { rules: NO_LAUNCH_RULES, creatorFeeBps: 100, customHook: null, customHookFlags: 0, label: 'mine' }, partnerWallet, 10_000);
// send token.createHolding(me, BRIDGED_SOL_MINT, partnerWallet) and made.instruction (signed by me and made.keypair);
// every launch then passes made.address as its launch config (createLaunch's options.launchConfig).

// Collect, whenever: anyone may send it; each party is paid to its own fixed holding.
const l = decodeLaunch((await connection.getAccountInfo(launchAddress(mint)))!.data);
const p = await partnerOf(connection, l);
const ix = launch.distributeFees(mint, BRIDGED_SOL_MINT, p!.config, l.creator, p!.partner);
```

A coin that pays a partner passes the partner's accounts on every claim: `launch.claimCreatorFees(…,
author, partner)` and `launch.claimAuthorFees(…, partner)` (`partnerOf` reads them; without them the
claim fails with `PartnerAccountsMissing`). `feeSplit(amount, authorShareBps, partnerShareBps)` is the
program's split.

**The router** (`docs/router.md`; 0.10.0). An app that routes swaps (a terminal, a wallet, a bot)
adds its own fee of 1 to 100 bps to any swap on any Bordrless pool: build the swap as usual, then
`router.swap(trader, integratorQuote, treasuryQuote, dexSwap, feeBps, minQuoteAfterFee)`. A fifth of
the fee goes to Bordrless, the rest to your holding of the pool's quote. On a native pool (0.14.0)
`launch.swap` builds `swap_v2` for a native launch: wrap it with
`router.swapV2(trader, integratorWallet, treasuryWallet, dexSwapV2, feeBps, minSolAfterFee)`, fees in
SOL to the wallets (`router.swap` throws on a `swap_v2`). `launch.swapClassic` keeps the classic swap.

**Payees** (`docs/payees-and-wallet-payouts.md`; 0.10.0). A companion coin's launcher shares their
part of the fees with up to 10 wallets, each a fixed share, set before the launch:
`companion.setPayees(payer, mint, [{ wallet, bps }])`; the keeper pays them with every withdraw. A
script companion may also pay any wallet SOL within its terms, once `companion.allowWalletPayouts`
is set before the launch.

## Companions: a launch whose creator is a program

A companion creates a launch and signs as its creator (`companionCreatorAddress(mint)`, the
companion address), so the launch's whole fee on every trade (`creatorFeeBps`) lands with it and
only its code spends it, by a split fixed at `create`: any
`{ buybackBps, holdersBps, beneficiaryBps }` summing to 10,000 (bought back and burned, streamed to
holders through the kit, paid to the launcher in SOL), the templates among them:
`COMPANION_TEMPLATES.buysItself` (all bought back and burned), `rugProofDev` (half to holders, half
to the launcher) or `buybackAndReward` (half bought back and burned, half to
holders). Launch with one through the site's API (`POST https://bordrless.app/api/launch/prepare`
with `companion: { split, vestDays? }` or `{ template, vestDays? }` (`vestDays` 0 by default: the first buy is
the launcher's at launch; 1 to 365 vests it); with `game`, `snowball` or
`script` for a Jackpot, a Snowball or a custom companion) or with `companion.create`,
`companion.launch` and `companion.devBuy`. Since the 2026-10-12 upgrade a companion may launch a
token with a custom hook too, from a plain config (no author share: `AuthorShareUnsupported`) and
with no holders' share; every step that moves the token then carries the hook's slice
(`LaunchKeys.customHook`). Keep the mint keypair until the launch confirms: if the setup lands and
the launch doesn't, only it can sign `companion.refund`.

Every later step is permissionless and pays its sender a bounty, so anyone can crank any companion:

```ts
import { rewardsOn } from '@bordrless/shared';
import { companion, companionAddress, companionVested, decodeCompanion, decodeLaunch, fetchAccount, launchAddress, launchKeysOf, launchRulesInputOf } from '@bordrless/sdk';

const c = (await fetchAccount(connection, companionAddress(mint), decodeCompanion))!;
const l = (await fetchAccount(connection, launchAddress(mint), decodeLaunch))!;
const keys = launchKeysOf(l);
const rewards = rewardsOn(launchRulesInputOf(l.rules));
const now = Math.floor(Date.now() / 1000);

// One step a transaction, in this order; each checks on chain that it is due.
const steps = [
  companion.claimFees(me, mint),                                  // creator fees in, split
  ...(c.pendingBuyback > 0n && now >= c.lastBuybackAt + c.buybackInterval ? [companion.buyback(me, keys, rewards)] : []),
  ...(c.pendingHolders > 0n ? [companion.share(me, mint)] : []), // to holders through the kit
  ...(c.pendingBeneficiary > 0n ? [companion.withdraw(me, mint, c.beneficiary)] : []),
  ...(companionVested(c, now) > c.devReleased ? [companion.release(me, keys, rewards, c.beneficiary)] : []),
];
```

### Creator fee and companion fee

On chain a launch has one `creatorFeeBps` (the whole fee); its companion splits every claim
(`split.beneficiaryBps` the launcher's part, `potBps` the pot's). `feeSplitOf({ creatorFeeBps: 100,
companionFeeBps: 50 })` gives `{ creatorFeeBps: 150, split: { beneficiaryBps: 6_667, ... }, potBps:
3_333 }`, rounded as the site rounds; `launchFeesOf(decodeLaunch(l), decodeCompanion(c))` reads the two
fees back. A pair config's fixed split is not on chain: `pairLauncherShareBps(inspection)` reads it
from the API's `ConfigInspection` (keeper.json `launcherShareBps`). `scriptAuthorShare(feeTaken,
hookCut, beneficiaryBps, { got, bountyBps })` is what a claim pays a script's author, as the companion
computes it: half of the launcher's part of the creator fee taken, never of the hook's cut or the pot.

## Games: a lottery coin run by its companion (v2, live on mainnet)

Companion v2 adds games (docs/games.md). Part of every fee claim goes into a pot, the coin's token
hook (`lotteryHook`, under the game ticket standard) keeps who holds tickets, and anyone draws and
pays the winner with ORAO VRF. The builders and decoders are here, held byte for byte to the Rust
clients (`vectors/companion-games.json`). Live on mainnet since 2026-10-09 (the site calls it the
Jackpot); rounds from 5 minutes since the 2026-10-12 upgrade (`MIN_ROUND_SECS`; the site offers 15
minutes and up). Bordrless's lottery hook has an audited `HookStatus` on mainnet, so its pots are
not capped and it cannot be blocked; a game on any other hook is capped at 10 SOL until audited,
and Bordrless can stop it (its pot is then bought back and burned; nobody is paid).

- **Through the site's API** (what the launch page's Lottery choice does): `POST
  https://bordrless.app/api/launch/prepare` with `rules: NO_RULES` and `companion: { split: {
  buybackBps, holdersBps: 0, beneficiaryBps }, game: { kind: 'lottery', roundSecs, potBps,
  minPotLamports, prizeBps, claimWindowSecs, maxAttempts } }` (`LOTTERY_DEFAULTS` in
  @bordrless/shared; the parts plus `potBps` sum to 10,000; `lotteryProblem` says what would be
  refused). It answers "Set up the lottery", the launch and the first buy, or 503 `lottery_off` at
  a creator fee Bordrless has no lottery launch config for. `GET companion/:mint?wallet=` answers
  the pot, the round, the holder's tickets and odds and the draw history (`CompanionStatus.game`);
  `POST game/enter/prepare { wallet, mint }` a holder's own entry.
- **Setup**, in one transaction: `companion.create`, then `lotteryHook.prepare(payer, mint,
  roundSecs)` (the mint signs), then `companion.createGame(payer, mint, { kind: 'lottery', hook:
  LOTTERY_HOOK_PROGRAM, ...LOTTERY_DEFAULTS })`. `gameArgsProblem` tells you what the program would
  refuse.
- **The launch:** from a `LaunchConfig` naming `LOTTERY_HOOK_PROGRAM` with `LOTTERY_HOOK_FLAGS`
  (145), through `companion.launch`, with `customHook: lotteryHook.accounts(mint)`. The token's
  moves take `launchKeys(..., lotteryHook.accounts(mint))`; a game coin's `devBuy` and `buyback`
  need about 450k compute units.

A round, cranked by anyone:

```ts
import { companion, decodeGame, fetchAccount, fetchSeedSlot, findWinningHolding, gameAddress, lotteryHook, roundOf } from '@bordrless/sdk';

const hook = c.gameHook!;                                     // decodeCompanion(...).gameHook
const g = (await fetchAccount(connection, gameAddress(mint), decodeGame))!;
const ixs = [lotteryHook.enter(mint, holder)];                // each holder once a round (or its own first trade)
if (g.status === 'idle') {
  // Commits the seed and requests it in one instruction. It must land within 3 slots of the slot
  // it names, else it fails with StaleSeed and is sent again from a newer one: fetch the blockhash
  // first, read the slot last (fetchSeedSlot), then send the draw on its own, at once, without
  // preflight.
  const at = await fetchSeedSlot(connection);
  ixs.push(companion.draw(me, mint, hook, roundOf(now, g.roundSecs) - 1, at, oraoTreasury, g.paidSeed));
}
if (g.status === 'requested') ixs.push(companion.reveal(me, mint, hook, g.request));
if (g.status === 'revealed') {
  const k = Math.floor((now - g.revealedAt) / g.claimWindowSecs); // the attempt whose window is open
  const won = await findWinningHolding(connection, mint, g.randomness, k, g.total, g.round);
  if (won) ixs.push(companion.claimPrize(me, mint, hook, k, won.owner)); // with a priority fee
}
```

`expire`, `retire` and `burnStranded` close what can't go on (the game's clocks:
`gameClaimsEnd`, `gameLastDraw`, `gameAttemptCloses`, `gameRetirableAt`, `companionStrandedAt`).
`oraoTreasury` is `decodeOraoNetworkState(...).treasury`. A draw the pot can't pay for, or one too
late for a claim window, rolls over by itself (no seed is committed). Under a blocked hook, send
`retire` (or `expire` mid-draw) while the pot holds anything: it moves the pot to the buyback. A game companion's `claimFees` takes its hook:
`companion.claimFees(me, mint, c.gameHook)`; its `devBuy` and `buyback` need a compute-unit limit
above the default 200k (about 260k to 390k). The backend's keeper (`apps/server/src/keeper/games.ts`)
runs this loop.

## Run a market maker on your fee wallet

A hook of yours can send a cut of every trade to a wallet you name, and the launchpad's creator fee
goes to the creator's wallet. `bordrless mm` is a bot you run yourself with that wallet's key that
trades on the token's own pool by thresholds: it buys when the price drops a step below its
reference, sells when it rises a step above, a fixed share of the wallet each time, and moves the
reference to each fill so it keeps buying on further drops and selling on further rises. Bordrless
hosts nothing and holds nothing: the bot reads the chain over the RPC you name, builds each swap
exactly as the site's API does (the holdings created idempotently, plain SOL wrapped into bridged
SOL on the way in, the token's hook and the pool hook's accounts resolved, a graduated launch pool
swapped through the launch program) and signs with your key. It refuses to run without `--keypair`.

```sh
bordrless mm --mint <mint> --keypair ~/fee-wallet.json --dry-run --once   # read the pool, print the plan, simulate, send nothing
bordrless mm --mint <mint> --keypair ~/fee-wallet.json --step 1 --buy 1 --sell 1 --interval 20 --max-sol 0.5 --slippage 1
```

- `--pool <address>` names the pool; without it the deepest pool quoted in bridged SOL is read from
  the DEX's accounts (a launch pool counts once graduated, never on its curve). `--step`, `--buy`,
  `--sell` and `--slippage` are percentages; `--max-sol` and `--max-tokens` cap one trade;
  `--ref <SOL per token>` sets the starting reference (the last run prints the one to carry on
  with); `--rpc <url>` (or `SOLANA_RPC_URL`), `--lookup-table <address|none>`, `--priority-fee`.
- Every evaluation reads the reserves and the wallet. A buy spends bridged SOL first and wraps plain
  SOL for the rest, keeping 0.02 SOL back for fees; a sell's proceeds stay in bridged SOL for the
  next buy. Nothing under 0.0001 SOL is traded. Each trade is dry-run first (the compute limit and,
  for a token with a hook of its own, the minimum out follow what the dry run delivers); one that
  fails on chain (slippage, a hook's refusal) is logged and the loop goes on. `--dry-run` simulates
  and prints every would-be trade without sending; `--once` evaluates once and exits.
- The header prints the pool, its reserves and fees, the price, the wallet's balances and the rules,
  and this line, which holds: **this bot trades with your money on a public pool; its trades count
  as volume. Disclose it.**

Caveats, by design: every round trip pays the pool's LP fee and the DEX's protocol fee (and, on a
launch pool, the creator and holder fees and the burn); the kit's or hook's tax applies to the
bot's own trades too; with a 1% step and fees above 1% a buy fills above the reference it reacted
to. It loses money by design: it is a treasury tool that keeps a chart moving and a fee wallet
working, not a source of profit. A trade large against the pool moves the spot a whole step past
its own fill; the reference then takes the spot after the trade, so the bot never trades straight
back against itself.

## Balances and decimals, for integrators

A Bordrless holding is an account of the token program, not an SPL or Token-2022 account, so the
RPC's `preTokenBalances` and `postTokenBalances` carry nothing for it: a terminal reading a trade
from the transaction meta sees no token movement at all. The token program emits an event for every
balance change instead, as a self-CPI in the inner instructions, each with the post-balances of the
holdings it touched: `Transferred { mint, source, destination, source_owner, destination_owner,
amount, deltas: [{ holding, owner, amount, post }], source_post, destination_post }`,
`Minted { destination, amount, destination_post, supply_post }`, `Burned { source, amount,
source_post, supply_post }`. The pre-balances follow: the source had `source_post + amount`, the
destination `destination_post − (amount − Σ deltas)` (a hook's cuts never reach it), each delta
holding `post − amount`.

Decimals are per mint, fixed at `create_mint`, 0 to 12: the launchpad's tokens are 6
(`TOKEN_DECIMALS` in `@bordrless/shared`, and will stay so), bridged SOL is 9, an LP mint is 9
(`LP_DECIMALS`), a free mint is whatever its creator chose. Read them from the mint account with
`decodeMint`, or from the `MintCreated` event; never hardcode 6.

`tokenBalanceChanges` takes any `getTransaction` reply (web3.js's `VersionedTransactionResponse`,
`ParsedTransactionWithMeta`, or the raw JSON) and answers in web3.js's `TokenBalance` shape, so SPL
code runs on it unchanged:

```ts
import { Connection } from '@solana/web3.js';
import { tokenBalanceChanges } from '@bordrless/sdk';

const connection = new Connection(RPC_URL);
const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
const { preTokenBalances, postTokenBalances, decimalsBy } = await tokenBalanceChanges(tx!, { connection });
for (const b of postTokenBalances) console.log(b.account, b.owner, b.uiTokenAmount.uiAmountString, decimalsBy[b.mint]);
```

- `preTokenBalances` and `postTokenBalances`: `{ accountIndex, account, mint, owner, programId,
  uiTokenAmount: { amount, decimals, uiAmount, uiAmountString } }` per holding, `account` being the
  holding's address (SPL code reads `accountKeys[accountIndex]`). A holding created in the
  transaction has no pre entry and one closed in it no post entry, as SPL accounts do.
- `changes`: one row per holding with `pre`, `post` and `change` in raw units, the ui strings,
  `created` and `closed`. `decimalsBy`: the decimals used, by mint.
- Decimals come from a `MintCreated` in the transaction, else `decimalsOf(mint)` if you pass one,
  else the mint accounts read over `connection` (`mintDecimalsReader`, one read per mint). With
  none, a `MissingDecimalsError` names the mints: nothing is guessed.
- `holdingBalanceChanges(events, decimalsBy, accountKeys)` is the same over decoded events
  (`eventsOf`), with no RPC. Several events on one holding chain in order (the first gives the pre,
  the last the post); a failed transaction gives empty arrays.
- Without the SDK: `GET https://bordrless.app/api/tx/<signature>/balances` answers
  `{ signature, slot, blockTime, err, preTokenBalances, postTokenBalances, changes, decimalsBy }`
  (the backend's `/v1/tx/:signature/balances`, behind the site's key); 404 for a signature with no
  confirmed transaction, 400 for a malformed one.

**A buy past the end of a launch's curve is filled** (the DEX and launchpad upgrade of 14 Oct
2026; [docs/hooks-v2.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/hooks-v2.md) §3.1). Nothing changes for a buy the curve can fill, a
sell or a graduated pool: the same instruction, accounts, fees, output and `Swapped` event. A buy of
more than the curve has left, which failed with `InsufficientLiquidity` before, now lands: the
program uses the smallest part of the input that sells the curve out, takes every token left and
leaves the rest of the input in the trader's holding of bridged SOL, and `graduate` can follow in
the same transaction. For a terminal that sends such a buy:

- `Swapped.amount_in` is the part used, so a trade read from the event or from the balances is
  right; the instruction's `amount_in` is only what was offered.
- The rest stays as bridged SOL unless the transaction unwraps it: append
  `bridge.unwrapSolAbove(user, bridgedBefore)` after the swap, as the site does (it refuses to
  unwrap nothing, so add it only where the buy may pass the end), or unwrap later.
- `min_amount_out` is held pro rata (`delivered >= min * used / offered`): give the least you accept
  for the whole input at the rate you quoted. A minimum computed from a quote that pretends the
  curve goes on past its end fails as `Slippage` (6017) where it failed as `InsufficientLiquidity`
  (6016) before.
- `swap/quote` says `amountUsed`, the part a buy would use (null when all of it), with the
  figures of that part; `curveFillBuy` in `@bordrless/shared` computes it off chain.
- Only a swap your transaction sends the DEX itself is filled. A program that calls the DEX (your
  own router program, Bordrless's router, a companion) gets no fill: its buy past the end fails
  with `InsufficientLiquidity` as before, so such a program never pays for SOL it didn't use.
- Give a filled buy room: its transaction (wrap, holdings and the swap) takes about 255,000 to
  275,000 compute units, above the 200,000 default. An ordinary buy costs about 900 more than
  before the upgrade.

## Hooks, companions and pairs from your own terminal

What a builder can make for a launch on Bordrless, in two layers. A **hook** is your program and
runs inside every trade: the token program calls it before and after each transfer, mint and burn,
and applies its answer (cuts, a refusal, 64 bytes of state written into each holding). A
**companion** is your program too, a script, but it never runs inside a trade: Bordrless's
companion program holds the launch's companion fee in a pot and calls your script on a timer with
the launch's accounts (the mint, the launch, the companion, the pool, your state, then whatever the
sender passes), your script reads what it likes (its hook's data in the holdings, the pool, its
state) and acts as the companion address, and the companion program executes within hard bounds:
it trades on the launch pool, buys back, burns, pays holders or wallets from the pot within the
terms the launch fixed when the script answers a payout ("Paying through the companion", below),
and refuses a step that spends more than the pot, touches the dev bag, takes lamports or breaks
custody. Bordrless's program is never upgraded for a builder's program, only for a new kind of
action. A **pair** is the two together, a hook on the trades and a companion on the pot: the hook
can take a cut, keep a score or fund the pot; the companion pays from the pot, filled by the
companion fee, by the hook's SOL cut, or both. A companion can also run on its own, funded by the
companion fee alone, and a hook can run without a companion (then there is only a creator fee).

**The fees.** On chain a launch charges one fee on each trade (`creatorFeeBps`, the whole). On a
companion coin the companion splits each claim of it: the launcher's part (`split.beneficiaryBps`)
is the **creator fee**, paid to the launcher, and the pot's part (`potBps`) is the **companion
fee**, which the script spends. The site shows the two as rows, "Creator fee" and "Companion fee",
together at most 5% of a trade (`MAX_CREATOR_FEE_BPS`, 500; it was 2% until 15 Oct 2026); each row is 0, 0.5%,
1% or 2% (`CREATOR_FEE_CHOICES_BPS`; the Companion fee from 0.5%), 1% by default, and a Workshop config's fee
is any quarter percent up to 5% (`FEE_STEP_BPS`). That 5% is the site's and the API's limit: the launchpad's
own cap (`Config.max_creator_fee_bps`) is 10%. A pair or a Workshop config fixes the split
(`launcherShareBps`, even by default; keeper.json's, 0 to 9,500, wins, so the pot keeps at least a
twentieth), and the API refuses any other (`split_fixed`): it is never the launcher's to adjust.

**Builder shares.** A hook's builder takes 0 to 50% of the creator fee in 5% steps
(`workshopAuthorShareOk`, `WORKSHOP_AUTHOR_SHARE_STEP_BPS`: its launch config's author share). A
companion's or a pair's builder takes exactly half or nothing (`SCRIPT_LIMITS.authorShareBps`), and
since the companion upgrade of 15 Oct 2026 that half is of the launcher's part of the creator fee
each claim takes (after the hook's SOL cut), paid out of that part: never of the companion fee, the
pot, the buyback, the holders or the hook's cut. The sender's bounty is taken from the whole claim,
and `FeesClaimed.toBeneficiary` is net of the author's share.

Two lanes, and the chain takes both:

| | The Workshop (https://bordrless.app/workshop) | Self-serve |
| --- | --- | --- |
| Who deploys | Bordrless, under its upgrade key, after its checks (the template's rules, the build, a hook's trading test, and one reading by AI that states its rules and judges it); approved by itself once the rules, the build and the trading test pass; you pay the submission fee and the deploy | You, then you make it immutable: `solana program set-upgrade-authority <program> --final` (`hookFinalCommand()` in @bordrless/shared; `bordrless hook deploy <so> --program-keypair <kp> --immutable` does both) |
| A hook | Listed; its config pays you 0 to 50% of the creator fee of launches others make with it, in 5% steps (up to `AUTHOR_SHARE_BPS`), as you choose at the submission | A config you make and share; `buildCreateListedConfig` can still pay you a share. On a Workshop hook of yours such a config is adopted once a launch uses it; on any other hook it is not offered on the site |
| A script | Approved on chain by Bordrless (`Approval`, `inspectScriptProgram`); its author paid half of the launcher's part of the creator fee (or nothing, as you choose) by the companion program, never of the pot | No approval needed: an immutable script runs unreviewed, with no author's share |
| What the site shows | Bordrless's reading of it (its rules as exact rows, the most it takes, what to watch, what it found) on the launch and token pages | A custom hook written by its creator, with who can upgrade it; no reading: not read by Bordrless, unless you submit its source with the program's address ("The reading lane", below). A launch whose creator fee goes to a program of your own (not the companion program) is allowed by the chain but hidden on the site |

Test first, on your machine, against the live programs copied from mainnet (`solana program dump
-u mainnet-beta <PROGRAM_ID> <file>.so`, in LiteSVM or `solana-test-validator`); the briefs on
https://bordrless.app/sdk/build hold the templates, the rules and the test plan. The trading test
itself is `studio-sim` (`programs/tests` in the monorepo: `cargo build --release -p
bordrless-program-tests --bin studio-sim`; `tools/studio-builder/sim/run.mjs` shows the flags it
runs with, `--so`, `--program-id`, `--flags auto`, `--programs <dir>`): with the monorepo checked
out you can run the same test on your binary before submitting. Every call below is in
`packages/sdk/src/terminal.test.ts`, built and read against a fake chain; the payout calls in
`lossCover.test.ts` and `payees.test.ts`.

**1. A trade hook** on the Workshop template (`tools/studio-builder/template`; the hook brief has
its Cargo.toml for a local build): `cargo build-sbf --tools-version v1.57 --arch v3`. Then either
submit `src/**.rs` on the Workshop, with `hook.json` beside them for a SOL cut (the launch prepares
a Workshop hook for each new mint itself; your listed config is made from its page, with the
creator fee of your choice, or here with `buildCreateListedConfig` and adopted once a launch uses
it), or:

```ts
import { Keypair } from '@solana/web3.js';
import { TOKEN_HOOK_FLAGS } from '@bordrless/shared';
import { buildCreateConfig, buildCreateListedConfig, inspectConfig, inspectTokenHook, NO_LAUNCH_RULES, templateHook } from '@bordrless/sdk';

// Deployed and made immutable (above). The launch page shows the mint address a launch will use:
// prepare the hook for it (the template's standard prepare: its state and its registry), signed by me.
const prepare = templateHook.prepare(hook, me, mint);

// What the launch page will say of the hook for that mint: deployed, immutable, prepared, and its accounts resolved.
const seen = await inspectTokenHook(connection, hook, mint);          // accepted: true, registryReady: true, problems: []

// The config: burn and the creator fee may go with a custom hook; holder rewards, max wallet and the locks may not.
const flags = TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA;   // what the hook answers
const made = buildCreateConfig(me, { rules: { ...NO_LAUNCH_RULES, burnBuyBps: 25, burnSellBps: 25 }, creatorFeeBps: 100, customHook: hook, customHookFlags: flags, label: 'mine' });
// or buildCreateListedConfig(me, { ...the same }, 5_000): half the creator fee of every launch someone else makes from it
// send made.instruction signed by me and made.keypair; share made.address: anyone pastes it under "Custom config".

// The same checks the page makes, with the mint: the bounds now, who can upgrade the hook, its registry.
const config = await inspectConfig(connection, made.address, mint); // problems: [], hookAccepted: true, registryReady: true
```

**2. A companion script** on the script template (`tools/studio-builder/template-script`; the
companion brief has its Cargo.toml): `companion_init` runs once at the setup with
`[creator (signer), mint, state, system program]` and your init data (at most 512 bytes);
`companion_step` runs from a minute after the launch, once an interval (10 s to a day), with
`[creator (signer), mint, launch, companion, pool, state]` then the extra accounts the sender
passed, none signing; the state is yours, made by the companion (`scriptStateAddress(mint)`, up to
10,240 bytes). The companion refuses a step that overspends the pot (`ScriptOverspent`), takes
the dev bag (`ScriptTookDevBag`), takes lamports (`ScriptTookLamports`) or breaks custody
(`ScriptBrokeCustody`), and an early one (`ScriptNotDue`). Build it with `anchor build`. Then
either submit it on the Workshop with its `keeper.json` (Bordrless deploys it and approves its
code on chain; launchers pick it on the launch page, which takes the step's interval from the
declaration, sends no init data and asks the launcher for nothing), or deploy it yourself and make
it immutable, and launch with it:

```ts
import { COMPANION_DEFAULTS, companion, inspectScriptProgram, scriptInitDataBytes } from '@bordrless/sdk';

// What the companion program will say of it: immutable (the self-serve lane), or approved (the Workshop's), or why not.
const status = await inspectScriptProgram(connection, script);     // lane: 'self-serve' | 'workshop' | null, problems: []

// The setup, before the launch, both signed by me and the mint: the companion, then its script.
const split = { buybackBps: 0, holdersBps: 0, beneficiaryBps: 3_000 };                // with potBps the four sum to 10,000
const setup = [
  companion.create(me, me, mint, { split: { buybackBps: 0, holdersBps: 0, beneficiaryBps: 10_000 }, ...COMPANION_DEFAULTS, fund }),
  companion.createScript(me, mint, { split, potBps: 7_000, program: script, interval: 60, stateLen: 128, initData: scriptInitDataBytes('0102') }),
];
// then companion.launchScript(...): companion.launch's arguments with the script's address appended, which a
// script companion needs while native launches are on (else MissingAccount) (the API does all three: POST launch/prepare with
// companion: { split, script: { potBps, program, interval, initData, stateLen } }).
```

Anyone cranks it, as any companion: `companion.claimFeesScript(me, mint, scriptClaimAuthor(script,
c))` claims the fees (the author's share, when there is one, out of the launcher's part), and once `scriptDue(c, s, now)`
holds, `companion.scriptStep(me, keys, s.program, extras)` runs a step, `extras` being what your
`companion_step` documents after its six accounts (a trade: the launch pool's swap accounts, as
`launch.swap(keys, creator, creator, 1, lamports, minOut)` names them); the sender is paid
`SCRIPT_LIMITS.bounty` from the pot. Bordrless's keeper steps every launched script, with what its
`keeper.json` asks for (below). A launch from the site asks for the state `keeper.json` says (`stateLen`, 1,024 bytes when it
says none) and gives `companion_init` its `initData` (hex; nothing when it says none).

**3. A pair** is submitted as one Workshop item (both sources, `keeper.json` beside the script's
and `hook.json` beside the hook's when they apply; one approval bound to both builds, one deploy,
one config that requires the script: the launch page locks the hook to it). Whale Bait, the first:
the hook cuts whale trades in tokens into the companion address's holding of the token, the script
sells them into the pot and pays the holders under 20M tokens once an epoch. On chain it is the
two above: a plain config on the hook (`buildCreateConfig`, never listed: a companion refuses an
author share, so the pair's builder is paid by the companion program alone) and
`companion.createScript` with the script in the same setup, the
launch wrapping `launch.createLaunch(companionCreatorAddress(mint), ..., { launchConfig,
customHook })` in `companion.launch`. Every step that moves the token then carries the hook's
slice (`launchKeys(..., config.hookAccounts)`). Which companion a config requires
(`ConfigInspection.requiredCompanion`) is the API's record until the on-chain `LaunchConfig`
field lands: the SDK cannot read it from the chain yet.

**4. Reading what is there:** `inspectConfig(connection, config, mint)` and
`decodeLaunchConfigAccount(data)` for a config (`decodeLaunchConfig` is the launchpad's own
`Config`, a naming kept for history); `decodeCompanion(data)` at `companionAddress(mint)`
(`script: true` for a custom companion, `snowball: true` for a Snowball, `gameHook` for a game);
`decodeScript(data)` at `scriptAddress(mint)` (the program, the interval, the last step, the
author, what it was paid); `decodeApproval(data)` at `approvalAddress(program)` (the kind, the
code hash, the ProgramData slot it was approved at, revoked or not, the author); the state at
`scriptStateAddress(mint)` is the script's own layout. `inspectScriptProgram` reads the three
together for a program.

### Holders your script pays: keeper.json

A script that pays holders needs their holdings among its step's accounts, and the sender of a step
chooses those. You never run a keeper: put **`keeper.json`** at the root of the script's source,
beside `src/` (where Cargo.toml sits), and submit it with the source. The Workshop checks it, the
reading reads it beside your code, the approval binds it, and Bordrless's keeper then brings what it
says to every step of every launch with your script; without one a step brings the pool's swap
accounts alone, so a companion that pays holders pays nobody. The schema (version 1, in
docs/scripts.md "What a script may ask the keeper for"): which holdings (`minBalance`,
`maxBalance` in base units or a field of your state; a filter on a field of their 64 bytes of hook
data against a constant, `"poolPrice"` or the current epoch), where each is paid (`owner`, the
owner's wallet; `ownerQuoteHolding`, the owner's bridged-SOL holding; `none`), how many a step
brings with the launch pool's swap accounts and without them, and whether it carries them
(`swapAccounts`), the token's hook accounts (`hookAccounts`) or the companion's payout accounts
(`payouts`, the payout path below); `stepSecs`, how often a step runs (10 s to a day; the launch
takes it from here, never from the launcher: without it a thirtieth of a fixed `roundSecs`, else a
minute, `keeperStepSecs`); `wallets`, up to 12 addresses or keys in your state a step brings
for wallet answers; `payoutTerms`, the payout terms the launch makes your script with ("Paying
through the companion", below); `mintWritable`, the coin's mint writable in every step (below);
`pools`, up to 3 other DEX pools each step brings (below); and `launcherShareBps`, the launcher's share of each trade's fee fixed for
every launch with your script (0 to 9,500 of 10,000; "0.5% to the launcher and 1.5% to the engine"
of a 2% fee is 2500). The fee a launch charges on each trade is one number on chain, split by the
companion at every claim: the launcher's share is their **creator fee**, paid to their wallet, and
the rest is the **companion fee**, the pot's, which your script spends. A pair's builder can fix
the same split on the Workshop's config page instead (two sliders, the creator fee and the companion
fee in quarter-percent steps; keeper.json's wins when both are set). Without either a pair's
config splits the fee evenly until its builder sets the split on the item's page. The launch page
shows a pair's split and the API refuses any other (`split_fixed`): it is never the launcher's to adjust. A hook's SOL cut
(hook.json, below) lands in the pot whole since the companion upgrade of 15 Oct 2026; before it,
the launcher's share applied to the cut too. Anyone can still send a step with any accounts: check every holding and payee
in the script itself. Only a holder answer reaches your hook’s `record_payout`; a wallet answer
emits `ScriptWalletPayout` with your tag and writes nothing on any holding, so a script that pays
wallets keeps what it has paid in its own state.

**A script that burns: `mintWritable`** (16 Oct 2026; default false). Every step then passes the
coin's mint writable, which a script that burns the coin (the token program's `burn`) needs: with
`swapAccounts` the mint already in the swap accounts is made writable and their order is unchanged;
without them the mint is appended last. Without the flag the mint is writable only on a launch with
a burn rate, and a burn elsewhere fails the whole step (`MintNotWritable`). A burn may take the coin
down to the dev bag still held, never into it (`ScriptTookDevBag`).

**A script that trades or fills other pools: `pools`** (17 Oct 2026; default none). A step brings
only the coin's own launch pool (`swapAccounts`) unless keeper.json names more: up to 3 plain DEX
pools (no pool hook), each by its two mints and its LP fee tier, which give its address
(`poolAddress(base, quote, feeBps, null)`): `{ "base": "coin", "quote": "<wBORDR mint>",
"liquidity": true }` for a coin/wBORDR pool, `{ "base": "<wBORDR mint>", "quote": "sol" }` for
wBORDR against SOL (`"coin"` is the coin's mint, `"sol"` is SOL and only ever a quote; `feeBps` is
the pool's LP fee in basis points, any whole number from 0 to 9,000 the DEX takes, 25 when absent:
name the fee the pool was made with, since it is part of the pool's address). Each step then carries, after the swap accounts, that pool's swap
accounts for the companion address (the pool, both mints, both vaults, the companion address's
holdings of both mints, the DEX's fixed accounts), the system program, the swap program, each mint's
token hook accounts, and with `liquidity` its LP mint and the LP holdings of the launch (the locked
one: mint LP into it and it is locked for good, as LiquidityTek does) and of the companion address.
A pool that does not exist yet is named all the same, so a script may create it. Find each account
by key. A step with other pools would not fit one transaction (a native step is 1,119 of its 1,232
bytes already), so a coin whose script declares pools gets an address lookup table of its own, made
and extended by Bordrless's keeper as its steps need (the first such step, and any step that brings new
fixed accounts, waits one pass). The reading says every pool a script brings.

**Figures on the coin's card: `view`** (16 Oct 2026; default none). Up to 6 figures a coin's page
shows live from your script's accounts, each `{ "label", "account", "offset", "width", "as" }`: a
label of up to 24 characters; `"account": "script"` (your state) or `{ "hook": ["state", "mint"] }`
(an account of the coin's custom hook at the address those seeds give under its program, each seed
a literal of up to 32 bytes or `"mint"` for the coin's mint); the bytes' `offset` and `width` (1, 2,
4 or 8, unsigned little-endian; 32 for a wallet); and `as`, how they read: `number`, `lamports` (as
SOL), `tokens` (of the coin), `bps` (a percentage), `time` (unix seconds, as how long until or
since), `secs` (a length of time), `wallet` (base58) or `flag` (Yes or No). A game's round and its
current winner belong there. Served raw as `ScriptSummary.view` on the coin's companion status.

**Native coins.** Every coin launched since 15 Oct 2026 trades in SOL: the pot is the companion
address's lamports above its rent, a script trades with `swap_v2` and pays a wallet with a system
transfer from the companion address. Pay holders with `"payTo": "owner"` (the owner's wallet after
each holding). `"ownerQuoteHolding"` (the owner's bridged-SOL holding) is the older coins' way: the
Workshop refuses a new script whose keeper.json pays to it without a native branch in its code
(`scriptNativeReady` in @bordrless/shared).

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { KEEPER_EXAMPLE, checkKeeperJson } from '@bordrless/sdk';

// The template's example (a dividend pair: holders under 20M tokens not paid this epoch, each paid to
// its SOL holding, 3 a step beside the swap accounts): start from it beside src/, then change it to your layout.
// It pays to "ownerQuoteHolding", the bridged-SOL way of the older coins: for a native coin, change payTo to "owner".
writeFileSync('my_script/keeper.json', KEEPER_EXAMPLE);
const checked = checkKeeperJson(readFileSync('my_script/keeper.json', 'utf8'));
if (!checked.ok) throw new Error(checked.problem);   // the sentence the Workshop would refuse it with
console.log(checked.words);                           // what its page will say: "Each step brings up to 3 holders ..."
```

### A hook that takes SOL: quote_cut and hook.json

A token hook only sees token transfers, so a cut it takes is in the token. Since the launchpad of
13 Oct 2026 a custom hook can also take SOL on every trade of its coin: it implements `quote_cut`,
which the launchpad calls (signing with `quoteCutSignerAddress(hook)`) on a coin whose config was
made with `launch.createQuoteCutConfig`, and takes the rate it answers (a `u16` of basis points, the
instruction's return value: `-> Result<u16>` in Anchor), at most the config's cap, from the trade's
SOL, and adds it to the launch's fee (counted with it, Bordrless's quarter taken from it the same
way). On a coin without a companion it is claimed with the creator fee (a listed config's author
share applies to it too); on a pair it lands whole in the companion's pot (since the companion
upgrade of 15 Oct 2026), not split with the launcher or the script's builder. In the Workshop you
don't make that config: put **`hook.json`** beside the hook's `src/` with its caps, and the Workshop makes the config with them once it is approved
(docs/workshop.md "A hook's SOL cut"). A hook with `quote_cut` must have one; a `hook.json` without
`quote_cut` is refused. The trading test runs the cut at the caps (every cut must be
min(answer, cap) of the SOL the launchpad passed), and the reading reads the caps beside the code.

**If you build the swap yourself** (a terminal, a router, a bot): a coin whose launch has a SOL cut
(`decodeLaunch(...).quoteCut`, `LaunchDetail.customHook.quoteCut` on the API) needs four more
accounts after the pool hook's four extras, or the DEX refuses the trade with
`QuoteCutAccountsMissing` (6047): the hook program, the trader's holding of the coin, the hook's
state `["state", mint]` and the launchpad's signer for the hook, in that order
(`quoteCutExtras(hook, mint, trader)`). `launchKeysOf(launch, hookAccounts)` and `launch.swap` do
this for you; a swap built from a pool's registry alone lands on every other coin and fails on
these (Axiom's router did, 15 Oct 2026). The coin's creator trading for itself skips them.

```ts
import { writeFileSync } from 'node:fs';
import { HOOK_JSON_EXAMPLE, checkHookJson } from '@bordrless/sdk';

writeFileSync('my_hook/hook.json', HOOK_JSON_EXAMPLE);   // up to 8% of a buy's SOL, nothing on sells
const checked = checkHookJson(HOOK_JSON_EXAMPLE);
if (!checked.ok) throw new Error(checked.problem);      // the sentence the Workshop would refuse it with
console.log(checked.words, checked.details[0]);          // what its page will say, and what a trader pays with Bordrless's 25% on top
```

### Paying through the companion: payouts

A script may also let the companion program pay (docs/loss-cover.md §1; Lossback's path, live). A
script made with `companion.createScriptV2` has payout terms, `PayoutTerms` at
`payoutTermsAddress(mint)`: the most one step pays of the pot, the most one holding (or wallet)
gets of a step's budget, the most a window pays (`windowBps` of `max(windowPot, potAfterScript +
windowPaid)` less what the window has paid, so fees arriving mid-window count; `payoutStepBudget`),
and the window (10 s to a day; `PAYOUT_LIMITS`, `payoutTermsValid`). Its `companion_step` then
answers, as return data, a `PayoutAnswer` (`encodePayoutAnswer`: version 1, up to 16 entries, each the index of a holding
among the step's extra accounts, lamports and a tag); the companion checks every entry against the
terms, pays each holding's owner SOL from the pot and has the token's hook record it
(`record_payout`, signed by `PAYOUT_AUTHORITY`; the hook needs `WRITES_HOOK_DATA` and that
instruction, the pair brief on https://bordrless.app/sdk/build spells it out), one bad entry
failing the whole step. With `companion.allowWalletPayouts(mint)` sent before the launch it may
answer wallets instead (`encodeWalletPayoutAnswer`, version 2). The step's extras start with
`companion.payoutAccounts(mint, hook)`, then each holding (writable) with its owner (writable):
`keeper.json` `{ "payouts": true, "payTo": "owner" }` has Bordrless's keeper bring exactly that.

```ts
import type { PublicKey } from '@solana/web3.js';
import { COMPANION_DEFAULTS, PAYOUT_LIMITS, companion, decodePayoutTerms, encodePayoutAnswer, launchKeysOf, payoutTermsAddress } from '@bordrless/sdk';

// The setup: the script made with create_script_v2, so it has payout terms (bps of the pot, of a step's budget, of
// the pot per window; the window in seconds).
const terms = { stepBps: 1_000, holdingBps: 10_000, windowBps: 2_500, windowSecs: 86_400 };
const setup = [
  companion.create(me, me, mint, { split: { buybackBps: 0, holdersBps: 0, beneficiaryBps: 10_000 }, ...COMPANION_DEFAULTS, fund }),
  companion.createScriptV2(me, mint, { split, potBps, program: script, interval: 15, stateLen: 128, initData: new Uint8Array() }, terms),
  // companion.allowWalletPayouts(mint): the script may then answer wallets too (encodeWalletPayoutAnswer).
];

// A step that answers payouts: the companion's payout accounts first, then each holding (writable) with its owner.
const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const extras = [...companion.payoutAccounts(mint, hook), ...candidates.flatMap((c) => [w(c.holding), w(c.owner)])];
const step = companion.scriptStep(me, launchKeysOf(l), script, extras);

// What the script's companion_step returns (set_return_data in Rust): version 1, up to
// PAYOUT_LIMITS.maxPayoutsPerStep entries, each the index of a holding among the extras, lamports and a tag.
const answer = encodePayoutAnswer({ version: 1, entries: [{ account: 7, lamports: 50_000_000n, tag: 12 }] });
const read = decodePayoutTerms((await connection.getAccountInfo(payoutTermsAddress(mint)))!.data); // paidTotal, walletsAllowed, …
```

The launch page makes the terms (`create_script_v2`) for a Workshop script whose `keeper.json` says
`payouts: true` (holder answers, version 1, recorded by the launch's hook) or names `wallets` (wallet
answers, version 2): its `keeper.json`'s `payoutTerms` when it names them, else open terms (since 16
Oct 2026: a step may pay the whole pot, one holding or wallet all of a step, a window all of the pot,
the window the shortest the program takes, 10 s). A script with neither launches without terms, and
a pair built for terms some other way launches through the SDK, as above.

Terms can change after the launch (the companion upgrade of 15 Oct 2026):
`companion.setPayoutTerms(authority, mint, { stepBps, holdingBps, windowBps, windowSecs })`
(`set_payout_terms`), signed by the launch's beneficiary (the launcher) or the script approver
(`NotTermsAuthority`, 6094, otherwise), within `createScriptV2`'s bounds. The window starts over,
what was paid stays counted, and `PayoutTermsSet` is emitted, as `create_script_v2` emits it.

```ts
const tighter = companion.setPayoutTerms(launcher, mint, { stepBps: 1_000, holdingBps: 2_500, windowBps: 5_000, windowSecs: 3_600 });
```

### The reading lane: Bordrless's words on a program you deployed

A program you deployed yourself (either lane above) is shown as not read by Bordrless. To have
Bordrless's reading on it, submit its source with the program's address on
https://bordrless.app/workshop/submit: the same submission fee and the same checks as its kind (a
hook: the rules, the build, the trading test, the reading; a companion: the rules, the build, the
reading), then Bordrless's build of your source is compared with the code on chain. Equal, the
item is `matched` and the reading, its rules and its verdict show wherever the program is used
(the launch page's config readout, the token page), as long as the code on chain stays that build;
a redeploy needs the new source sent as a fix. Nothing is deployed, no key of Bordrless's is
involved, no share is paid, and the item is never on the Workshop's shelves. The build is of your
source on Bordrless's template with your own program id in `declare_id!`, so it can only match a
program built from that same source (`WorkshopSubmitRequest.program`, `WorkshopItem.lane`,
`WorkshopDetail.match` in @bordrless/shared).

### Write it so the reading can state it

The reading (one AI pass, `apps/server/src/workshop/reader.ts`) states a hook's rules as exact
rows ("Under 5M tokens: 0% hook tax", "5M–10M tokens: 3% of the tokens on buys and sells, to the
pot", "Transfers: free") and a companion's steps ("Every 5 minutes: the pot pays holders under 20M
tokens"), which the Workshop card, the launch page and the token page show (`WorkshopReading.rules`,
`WorkshopReadingRule` in @bordrless/shared); a rate read from an account the code does not bound has
no fixed rate. Write every rate, threshold and period as a named constant, one tier per constant,
and keep the hook data layout in a comment with offsets: the trading test's largest cut is held
against the reading, and a reading that said less is written again. The reading also judges the
code (a verdict with findings, shown on the item's page); it never holds the approval, which is
automatic once the rules, the build and the trading test pass. A reading by AI and a test, not an
audit.

## Where to read more

- The SDK page, with the hook interface and the examples: https://bordrless.app/sdk
- Build with your own agent (the briefs, the templates, the test plan, the Workshop): https://bordrless.app/sdk/build
- Build on Bordrless: what is open, what it costs, what stays Bordrless's: https://bordrless.app/docs/build
- Companions with the SDK (the API path, the builders, the rules, cranking, scripts): https://bordrless.app/sdk/companions
- The standard in full: https://bordrless.app/docs

Status: the programs are live on mainnet, one set of ids on every cluster (in `@bordrless/shared`);
they keep an upgrade authority until audited. A token with a custom hook is launched from a
`LaunchConfig` made with this SDK ("Custom config" on the launch page), its hook immutable,
timelocked or upgradeable only by Bordrless, or created directly through `token.createMint`. Pools
for any pair (`swap.createPool`), curves a program of yours opens as its hook (`swap.createPool`
with `hookAuthority(program)`, `swap.finalizeCurve`) and bridged assets (`bridge.register`) need
nobody's permission. Companions (`bordrless_companion`) are live on mainnet too, with games,
Snowball, scripts, payouts and payees; an immutable script runs with no approval.
