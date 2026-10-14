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
   pays you half the creator fee of every launch someone else makes from it) and share its key.
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
the fee goes to Bordrless, the rest to your holding of the pool's quote.

**Payees** (`docs/payees-and-wallet-payouts.md`; 0.10.0). A companion coin's launcher shares their
part of the fees with up to 10 wallets, each a fixed share, set before the launch:
`companion.setPayees(payer, mint, [{ wallet, bps }])`; the keeper pays them with every withdraw. A
script companion may also pay any wallet SOL within its terms, once `companion.allowWalletPayouts`
is set before the launch.

## Companions: a launch whose creator is a program

A companion creates a launch and signs as its creator (`companionCreatorAddress(mint)`), so every
creator fee lands with it and only its code spends it, by a split fixed at `create`: any
`{ buybackBps, holdersBps, beneficiaryBps }` summing to 10,000 (bought back and burned, streamed to
holders through the kit, paid to the launcher in SOL), the templates among them:
`COMPANION_TEMPLATES.buysItself` (all bought back and burned), `rugProofDev` (half to holders, half
to the launcher, whose first buy vests) or `buybackAndReward` (half bought back and burned, half to
holders). Launch with one through the site's API (`POST https://bordrless.app/api/launch/prepare`
with `companion: { split, vestDays? }` or `{ template, vestDays? }`; with `game`, `snowball` or
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

## Hooks, companions and pairs from your own terminal

What a builder can make for a launch on Bordrless, in two layers. A **hook** is your program and
runs inside every trade: the token program calls it before and after each transfer, mint and burn,
and applies its answer (cuts, a refusal, 64 bytes of state written into each holding). A
**companion** is your program too, a script, but it never runs inside a trade: Bordrless's
companion program holds the launch's creator fee in a pot and calls your script on a timer with
the launch's accounts (the mint, the launch, the companion, the pool, your state, then whatever the
sender passes), your script reads what it likes (its hook's data in the holdings, the pool, its
state) and acts as the creator address, and the companion program executes within hard bounds:
it trades on the launch pool, buys back, burns, and refuses a step that spends more than the pot,
touches the dev bag, takes lamports or breaks custody (payouts to holders are coming, below).
Bordrless's program is never upgraded for a builder's program, only for a new kind of action. A
**pair** is the two together: the hook records at transfer time, the script reads the record and
pays.

Two lanes, and the chain takes both:

| | The Workshop (https://bordrless.app/workshop) | Self-serve |
| --- | --- | --- |
| Who deploys | Bordrless, under its upgrade key, after its checks (the static rules, a review by AI, the build, the trading test, a reading); you pay the submission fee and the deploy | You, then you make it immutable: `solana program set-upgrade-authority <program> --final` (`hookFinalCommand()` in @bordrless/shared; `bordrless hook deploy <so> --program-keypair <kp> --immutable` does both) |
| A hook | Listed; its config pays you half the creator fee of launches others make with it (`AUTHOR_SHARE_BPS`) | A config you make and share; `buildCreateListedConfig` can still pay you a share, but the config is then not offered on the site |
| A script | Approved on chain by Bordrless (`Approval`, `inspectScriptProgram`); its author paid the same half by the companion program | No approval needed once the companion upgrade of 2026-10-12 evening is live: an immutable script runs unreviewed, with no author's share |
| What the site shows | Bordrless's reading of it (what it does, the most it takes, what to watch) on the launch and token pages | A custom hook written by its creator, with who can upgrade it; no reading: not read by Bordrless. A launch whose creator fee goes to a program of your own (not the companion program) is allowed by the chain but hidden on the site |

Test first, on your machine, against the live programs copied from mainnet (`solana program dump
-u mainnet-beta <PROGRAM_ID> <file>.so`, in LiteSVM or `solana-test-validator`); the briefs on
https://bordrless.app/sdk/build hold the templates, the rules and the test plan. Every call below
is in `packages/sdk/src/terminal.test.ts`, built and read against a fake chain.

**1. A trade hook** on the Workshop template (`tools/studio-builder/template`; the hook brief has
its Cargo.toml for a local build): `cargo build-sbf --tools-version v1.57 --arch v3`. Then either
submit `src/**.rs` on the Workshop (the launch prepares a Workshop hook for each new mint itself,
and your listed config is made from its page), or:

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
either submit it on the Workshop (Bordrless deploys it and approves its code on chain; launchers
pick it on the launch page), or, once the companion upgrade of 2026-10-12 evening is live, deploy
it yourself and make it immutable, and launch with it:

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
// then companion.launch(...) as for any companion (the API does all three: POST launch/prepare with
// companion: { split, script: { potBps, program, interval, initData, stateLen } }).
```

Anyone cranks it, as any companion: `companion.claimFeesScript(me, mint, scriptClaimAuthor(script,
c))` claims the fees (the author's half first, when there is one), and once `scriptDue(c, s, now)`
holds, `companion.scriptStep(me, keys, s.program, extras)` runs a step, `extras` being what your
`companion_step` documents after its six accounts (a trade: the launch pool's swap accounts, as
`launch.swap(keys, creator, creator, 1, lamports, minOut)` names them); the sender is paid
`SCRIPT_LIMITS.bounty` from the pot. Bordrless's keeper steps every launched script.

**3. A pair** is submitted as one Workshop item (both sources; one approval bound to both builds,
one deploy, one config that requires the script: the launch page locks the hook to it). On chain
it is the two above: a plain config on the hook (`buildCreateConfig`, never listed: a companion
refuses an author share) and `companion.createScript` with the script in the same setup, the
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
review reads it beside your code, the approval binds it, and Bordrless's keeper then brings what it
says to every step of every launch with your script. The schema (version 1, in
docs/scripts.md "What a script may ask the keeper for"): which holdings (`minBalance`,
`maxBalance` in base units or a field of your state; a filter on a field of their 64 bytes of hook
data against a constant, `"poolPrice"` or the current epoch), where each is paid (`owner`, the
owner's wallet; `ownerQuoteHolding`, the owner's bridged-SOL holding; `none`), how many a step
brings with the launch pool's swap accounts and without them, and whether it carries them. Anyone
can still send a step with any accounts: check every holding and payee in the script itself.

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { KEEPER_EXAMPLE, checkKeeperJson } from '@bordrless/sdk';

// The template's example (a dividend pair: holders under 20M tokens not paid this epoch, each paid to
// its SOL holding, 3 a step beside the swap accounts): start from it beside src/, then change it to your layout.
writeFileSync('my_script/keeper.json', KEEPER_EXAMPLE);
const checked = checkKeeperJson(readFileSync('my_script/keeper.json', 'utf8'));
if (!checked.ok) throw new Error(checked.problem);   // the sentence the Workshop would refuse it with
console.log(checked.words);                           // what its page will say: "Each step brings up to 3 holders ..."
```

### Compose a hook: rules, no program

The third way (docs/rules-lane.md): most custom hooks are a few conditions over a holding's state
and a few actions on the transfer. Write exactly that as data, bind it to a launch config, and
Bordrless's one rules engine (`rules_hook`) runs it; the site reads the bytes back word for word,
with no review, no build and no trading test, and lists it with no submission fee. A rule set is at
most 6 rules; each runs `on` some sides (sell, buy, send, receive, burn), `when` up to three
conditions all hold, `unless` one holds, and `then` takes a cut (1 to 1,500 bps of the amount, the
cuts of a side at most 1,500 in all, burned or paid to the creator or a named wallet), refuses the
operation with a reason, counts, or marks the holding. No oracle: a dollar threshold is fixed in SOL
when the set is composed, and the sentence says the SOL figure.

```ts
import { buildCreateComposedConfig, rules, workshop } from '@bordrless/sdk';

const set = rules
  .compose({ keeps: ['entry'], destination: 'burn' })
  .rule({ on: ['sell'], when: [rules.gain.gt(0)], then: rules.cut(500) })
  .build();                                       // throws the engine’s own refusal, by code (RulesError.code)
const words = rules.render(set);                  // { sentences, mostTakes, flags, watch, keeps }
// words.sentences: ["Takes 5% of every sell by a holder in profit, burned.", "Holders under water sell free."]
// words.mostTakes.text: "5% of a sell; nothing from buys or transfers"; words.flags: 209

const made = buildCreateComposedConfig(me, { label: 'Loss shield', creatorFeeBps: 100, listed: true }, set);
// made.instructions: create_listed_config (half the creator fee to you on launches by others) then bind,
// in ONE transaction signed by me and made.keypair; made.address is the key to paste under "Custom config".
// Once it landed, list it on the Workshop's shelves as the wallet that made it (six a day, no fee):
const session = await workshop.signIn(me, signMessage);          // the Workshop's sign-in message: a message, never a transaction
const item = await workshop.registerComposed(made.address, session); // lane: 'rules', approved at once, its words read from its rules
```

The values a rule can see (`rules.amount`, `amountShare`, `balanceBefore`, `balanceAfter`,
`shareAfter`, `tradePrice`, `spotPrice`, `gain`, `loss`, `valueBefore`, `valueAfter`,
`sinceReceived`, `sinceSent`, `age`, `firstAfterLaunch`, `sinceLaunch`, `counter`,
`flag(k)`, and `graduated`, `hasEntry` with their negations), the actions (`rules.cut(bps)`,
`rules.refuse('cooling' | 'cap' | 'locked' | 'rule')`, `rules.count('add' | 'reset')`,
`rules.mark(k, set)`) and every bound are docs/rules-lane.md §1; what the engine keeps per holding
(`keeps: ['entry' | 'times' | 'count']`) must cover what the conditions read. Reading what is
there: `decodeRuleSetAccount(data)` at `ruleSetAddress(config)`, `decodeRulesState(data)` at
`rulesStateAddress(mint)`, `decodeRulesHolding(hookData)` (the 64 bytes, the Loss cover script's
fields at the same offsets, so Lossback runs unchanged on a composed hook). `rulesHook.prepare(me,
mint, config)` prepares the engine for a mint of your own; the launch does it for its own.

When the lane cannot say it (randomness, a call into a program, a second cut destination, a price
feed: §1.4), `rules.toStarter(set)` writes the Workshop template's `src/lib.rs` with the same rules
spelled out in Rust (`rules::decide` on plain numbers), so the code lane starts from a familiar
file. Every call here is in `packages/sdk/src/rules.test.ts`, against the shared vectors
(`packages/shared/vectors/rules.json`) the engine's own tests read. The engine is not deployed
yet: `RULES_HOOK.deployed` says so, and `RULES_HOOK_PROGRAM` is a placeholder until it is.

**Coming, not built:** the payout answer (docs/loss-cover.md §1): a `companion_step` will answer
a `PayoutAnswer` (up to 16 holdings among its extra accounts, with lamports and a tag) that the
companion pays from the pot within bounds and records through the hook. Its encoder lands in
`scripts.ts`, `companion.createScriptV2` and `decodePayoutTerms` in `companion.ts`.

## Risk labels, timelocks, strategies and vaults (0.8.0 and later)

- `hookRiskLabel(connection, program, { mint })`: who can change a hook (immutable, timelocked N days,
  Bordrless-managed, author-upgradeable), whether its code is audited or Studio-attested, and any other
  programs it calls. Show it next to every custom-hook token.
- `timelock`: put your own hook or strategy's upgrade authority behind a public delay (at least 3
  days, only ever lengthened), propose code by hash, execute after the delay, or finalize to immutable.
- `strategy`: a companion game whose payouts your program decides, within the companion's caps.
- `vault`: route a hook's cut to slots that burn, sell for SOL to a fixed wallet, or buy and burn
  another token, fixed before launch.
- The `bordrless` CLI (`npx bordrless --help`): build, deploy (immutable or timelocked), register,
  propose and execute.

Design: [docs/phase3a.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/phase3a.md).

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
Snowball and scripts; immutable scripts with no approval run once the companion upgrade of
2026-10-12 evening is live.
