# 4. Trading

Quote a trade, build it, let the user's wallet sign and send it. All of it is permissionless; there
is no Bordrless API in the path.

Launch pools trade **SOL**. Since 15 Oct 2026 (new launches since 16 Oct) almost every pool holds
it natively, as lamports on the pool account, and trades with `swap_v2`: the wallet pays a buy in
SOL and a sell pays SOL to the wallet, with **no wrap, no unwrap and no bridged-SOL holding**. A
native pool keeps its address and its `quote_mint` (bridged SOL, `A49oVh…`, still in its seeds), so
nothing is re-keyed. `launch.swap` builds `swap_v2` for a native pool by itself
([Native SOL pools](#native-sol-pools-swap_v2)).

**Don't wrap SOL for a native pool**: what you wrap is not spent and stays in the wallet's
bridged-SOL holding. Only the pools still on **bridged SOL** (pool
`4PvPnTByfrnhA1nNmsaou7GrdQsqJNrkinqLHp2JHFX7` for good, coin
`5DMBPNoYAmbiNnRyRkWS7BetnfvAzbUqXyXNiw6Hn7hh` for now) trade the classic way: a buy wraps the SOL
on the Bordrless bridge first and a sell unwraps it after, in the same transaction. Decide from
`Pool.quoteNative`, never from the address.

## A buy, end to end

From [`quote-buy.ts`](../../examples/quote-buy.ts), which quotes, builds and simulates without
sending:

```ts
import { BPS, KIT_MODULES, mulDivFloor, quoteLaunchSwap, sniperLpFee } from '@bordrless/shared';
import { PublicKey } from '@solana/web3.js';
import {
  bridge, buildV0Transaction, decodeKitConfig, decodeLaunch, decodePool, fetchCustomHookAccounts,
  launch as launchIx, launchAddress, launchKeysOf, setComputeUnitLimit, setComputeUnitPrice, token,
} from '@bordrless/sdk';

const launch = decodeLaunch((await connection.getAccountInfo(launchAddress(mint)))!.data);
const [poolInfo, kitInfo] = await connection.getMultipleAccountsInfo([launch.pool, launch.kitConfig]);
const pool = decodePool(poolInfo!.data);
const kit = (launch.modules & KIT_MODULES.HOLDER_REWARDS) !== 0 && kitInfo ? decodeKitConfig(kitInfo.data) : null;
const native = pool.quoteNative === true; // SOL as lamports on the pool: swap_v2, no wrap

// 1. Quote.
const lpFeeBps = sniperLpFee(now, launch.createdAt, launch.sniperWindowSecs, launch.sniperStartBps, launch.lpFeeBps);
const quote = quoteLaunchSwap(pool, 'buy', lamports, lpFeeBps, pool.protocolShareBps, {
  creatorFeeBps: launch.creatorFeeBps,
  holderFeeBuyBps: launch.rules.holderFeeBuyBps, holderFeeSellBps: launch.rules.holderFeeSellBps,
  burnBuyBps: launch.rules.burnBuyBps, burnSellBps: launch.rules.burnSellBps,
  eligible: kit?.eligible ?? 0n, minEligible: kit?.minEligible ?? 0n,
});
const minOut = mulDivFloor(quote.delivered!, BPS - slippageBps, BPS);

// 2. Build. A token with a custom hook (Half-Life, a game coin, "Build your own") needs its hook's
//    accounts, resolved from the hook's registry for the mint.
const customHook = launch.customHook ? await fetchCustomHookAccounts(connection, launch.customHook, mint) : null;
const keys = launchKeysOf(launch, customHook, { poolNative: native }); // swap_v2 for any native pool
const ixs = [
  setComputeUnitLimit(400_000), setComputeUnitPrice(priorityMicroLamports), // or the simulated units + 15%
  ...(native ? [] : [
    token.createHolding(wallet, launch.quoteMint, wallet),   // a bridged pool only: its bridged-SOL holding (idempotent)
    bridge.wrapSol(wallet, lamports),                        // and SOL -> bridged SOL
  ]),
  token.createHolding(wallet, mint, wallet),                 // its holding of the token (idempotent)
  launchIx.swap(keys, wallet, wallet, 1, lamports, minOut),  // direction 1 = buy; swap_v2 on a native pool: the wallet pays SOL
];
const PROTOCOL_LOOKUP_TABLE_ADDRESS = new PublicKey('4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ'); // mainnet
const table = (await connection.getAddressLookupTable(PROTOCOL_LOOKUP_TABLE_ADDRESS)).value!;
const tx = buildV0Transaction(wallet, ixs, (await connection.getLatestBlockhash()).blockhash, [table]);

// 3. Have the wallet sign and send it (`signAndSendTransaction`).
```

## Coins whose hook takes a SOL cut

Some coins' custom hooks take a cut of a trade's SOL (a Workshop hook on a config made with
`create_quote_cut_config`, up to 10% a side; [quote-cut.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/quote-cut.md)).
`launch.quoteCut` (decoded from `Launch.reserved[0..4]`) is non-null on such a coin. **Every trade
of it passes four more accounts** after the launch pool's usual four hook extras, or the launchpad
refuses it with `QuoteCutAccountsMissing` (6047):

| # | Account | Writable |
| --- | --- | --- |
| 1 | the custom hook program (`launch.customHook`) | no |
| 2 | the trader's holding of the token, `holding(mint, trader)` (the swap's signer, not the recipient) | no |
| 3 | the hook's state, `PDA(["state", mint], hook)` | yes |
| 4 | the launchpad's signer for the hook, `PDA(["quote-cut", hook], launchpad)` | no |

`launch.swap` adds them for you; `quoteCutExtras(hook, mint, trader)` returns them for your own
builder. They are also in the pool's registry (`hook_accounts_address(launchpad, pool)`, entries 9
to 12), so a client that resolves the registry instead of hardcoding four extras gets them without
special cases. Passing someone else's holding or a read-only state fails as `QuoteCutWrongAccount`.

**If your on-chain program calls the DEX** (a router, an aggregator, a bot), the trader is the
account that signs the DEX's `swap`, which may be your program's address: pass the four accounts
for that trader through to the DEX in the same order. Coins without a SOL cut need nothing extra,
so a program that only passes four extras will trade most coins and fail every trade of these.

**Quotes:** the hook decides its rate at trade time, so `quoteLaunchSwap` can't include it; simulate
for the exact figure. The trader pays about 1.25 times the cut (Bordrless's 25% share applies to
it as to the creator fee). Show the coin's caps (`launch.quoteCut`) before the trade.

## A sell

Same shape, direction 0, the token amount in. On a native pool that is all: `launch.swap` builds
`swap_v2` and the SOL lands in the wallet, and `minSolOut` is the lamports delivered.

```ts
const ixs = [
  setComputeUnitLimit(400_000), setComputeUnitPrice(priorityMicroLamports),
  launchIx.swap(keys, wallet, wallet, 0, tokenAmount, minSolOut),  // direction 0 = sell; SOL to the wallet
];
```

On a bridged pool, unwrap after:

```ts
const bridged = await connection.getAccountInfo(holdingAddress(launch.quoteMint, wallet));
const bridgedBefore = bridged ? decodeHolding(bridged.data).amount : 0n; // the wallet's bridged SOL now
const ixs = [
  setComputeUnitLimit(400_000), setComputeUnitPrice(priorityMicroLamports),
  token.createHolding(wallet, launch.quoteMint, wallet),
  launchIx.swap(keys, wallet, wallet, 0, tokenAmount, minSolOut),  // direction 0 = sell
  bridge.unwrapSolAbove(wallet, bridgedBefore),                    // what the sell delivered, back to SOL
];
```

`unwrapSolAbove(wallet, keep)` unwraps everything above `keep`, so a user's existing bridged SOL
stays bridged. Quote a sell with `quoteLaunchSwap(pool, 'sell', tokenAmount, …)`: its `delivered` is
the SOL the wallet receives (lamports on a native pool, bridged SOL on a bridged one).

## Quoting exactly

`quoteLaunchSwap` runs the program's own arithmetic: the token hook's cuts and burn, the LP fee,
Bordrless's share, the curve, and the creator and holder fees. Measured against a simulation of
the same transaction on mainnet (2026-10-09, `quote-buy.ts`):

| Token | Rules | Quoted for 0.1 SOL | Simulated |
| --- | --- | --- | --- |
| A Half-Life token | Half-Life hook, creator 1% | 1,630,280.020655 | 1,630,280.020655 |
| A holder-rewards token | holder rewards 0.5%, creator 0.5% | 2,269,499.301361 | 2,269,499.301361 |
| A plain token | none, creator 1% | 2,287,625.252001 | 2,287,625.252001 |

Three inputs change the quote:

- **The LP fee:** `sniperLpFee(now, …)` falls from 80% to 0.3% over the first 30 seconds after
  `launch.createdAt`. It's Bordrless's, in SOL: a buy pays it from the SOL in, before the curve; a
  sell from the curve's SOL output. `quote.lpFee` is in SOL on both sides. Use the time the trade is expected to land, not when the user started typing.
  The creator's own first buy in that window pays the base fee (`launch.creatorBought` turns true
  after it).
- **Holder rewards** are only taken while `kit.eligible >= kit.minEligible`: a token with holder
  rewards takes none until enough of the supply is held outside the pool. `quoteLaunchSwap` handles
  this when you pass the kit's two figures.
- **A custom hook's own cut** (Half-Life's exit fee on sells, a Studio hook's, any "Build your
  own" hook) is **not** in `quoteLaunchSwap`. For those tokens, **simulate the transaction** and
  read the wallet's holding afterwards (the `accounts` option of `simulateTransaction`); that's
  how `quote-buy.ts` measures. For Half-Life you can also compute the cut:
  [Hooks](05-hooks-and-risk.md#half-life). Game coins' hooks (lottery, jackpot, streak) take no
  cut: a companion launch accepts only their flags, 145, which have no cut bit. Simulate them
  anyway, since a custom hook can refuse a transfer.

Simulation never needs a signature (`sigVerify: false`, `replaceRecentBlockhash: true`), so you can
quote for any wallet that holds the input.

## Slippage

`minAmountOut` is checked against what the **recipient's holding gains**, after every fee and hook
cut. Set it from the quote (or the simulation) less your tolerance. A swap below it fails with the
DEX's `Slippage` error, and nothing moves.

## Graduation

When a buy takes the pool's real SOL to `launch.graduationQuote` or past it, or buys the last
tokens on the curve, the launch can graduate. Anyone may call it, and the buyer's transaction is the natural place:

```ts
import { buyGraduates } from '@bordrless/shared';

if (pool.curve && buyGraduates(pool, quote, launch.graduationQuote)) {
  ixs.push(launchIx.graduate(wallet, mint, launch.quoteMint, launch.lpFeeBps, launch.modules, customHook));
}
```

If no buyer carries it, anyone can send `launch.graduate(...)` on its own later. The program only
checks that `pool.quoteReserve >= launch.graduationQuote` or `pool.baseReserve == 0`, and that
the pool is still a curve.

**A buy larger than what's left on a launch's curve is filled** (since 14 Oct 2026): the program
uses the smallest part of the input that sells the curve out, takes every token left and leaves the
rest of the input with the buyer (in the wallet on `swap_v2`, in its bridged-SOL holding on the
classic `swap`); `graduate` can follow in the same transaction.

- `Swapped.amountIn` is the part used; the instruction's `amount_in` is only what was offered.
- On a bridged pool, append `bridge.unwrapSolAbove(wallet, bridgedBefore)` after such a buy to
  return the rest as SOL (it refuses to unwrap nothing, so add it only where the buy may pass the
  end). `swap_v2` never takes the rest from the wallet.
- `minAmountOut` is held pro rata (`delivered >= min * used / offered`): give the least you accept
  for the whole input at the quoted rate. A minimum from a quote that pretends the curve goes on
  fails as `Slippage` (6017).
- The fill is the launchpad's and only for a swap your transaction sends the DEX itself. A program
  that calls the DEX (your router program, a companion) gets none, and a curve another program opens
  never fills (`BadFill`, 6038): there a buy past the end still fails with `InsufficientLiquidity`.
- Give the transaction about 275,000 compute units: a filled buy with its holdings (and a wrap on
  a bridged pool) is above the 200,000 default.
- `curveFillBuy` in `@bordrless/shared` gives the part used off chain; `swap/quote` answers it as
  `amountUsed`.
`curveMaxBuyIn(pool, lpFeeBps, protocolShareBps, feeParams)` gives the largest buy the curve can
still fill.

## Fees and compute

- **Compute:** simulate and request the units used plus 15%. A buy with SOL used 136,760
  (a plain token), 152,376 (a Half-Life token) and 166,537 (a holder-rewards token) compute units in mainnet
  simulations on 2026-10-09. A custom hook adds its callbacks, and graduation in the same
  transaction adds much more. When you can't simulate, the Bordrless backend's fallbacks are a
  guide: 400,000 for a trade, 700,000 for a trade that graduates, 300,000 for a wallet-to-wallet
  send of a hooked token. A game coin's companion buy (the launcher's dev buy, a buyback) measured
  260,000–390,000.
- **Priority fees:** add `setComputeUnitPrice`. The fee is charged on the limit you request, so a
  limit from the simulation costs less than a fixed high one.
- **Rent:** a wallet's first trade of a token creates its holding (about 0.0023 SOL); on a bridged
  pool the first buy with SOL creates its bridged-SOL holding too.
- **The protocol's take** is in the quote (`protocolFee`), never extra.

## When a trade is refused

`explainFailure(logs, err)` turns a failed simulation or transaction into the program's own
sentence:

```ts
import { explainFailure } from '@bordrless/sdk';

const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
if (sim.value.err) console.log(explainFailure(sim.value.logs ?? [], sim.value.err)?.explanation);
```

The ones users meet:

| Error | Why | What to show |
| --- | --- | --- |
| `Slippage` | The price moved, or a hook took more than expected | Raise slippage or retry |
| `InsufficientLiquidity` | The buy is larger than what's left on the curve | Offer the largest fillable buy |
| `MaxWalletExceeded` (kit) | The token caps how much one wallet holds until graduation | The cap is `kit.maxWalletAmount` |
| `CreatorLocked` (kit) | The creator's wallet can't sell or send until `launch.creatorUnlockAt` | Show the unlock time |
| `EarlyLocked` (kit) | Tokens bought in the first seconds stay until `launch.earlyUnlockAt` | Show the unlock time |
| `FurnaceNotLit` (Half-Life) | The launch's last step hasn't landed yet; buys work | Retry in a few seconds |
| `Paused` | The DEX or the launchpad is paused | Trading is paused |
| `BufferShort`, `LamportsShort` | The classic `swap` on a native pool: a sell the buffer can't cover (sent by a program, a delegate, or on a held coin), or a buy on a fresh native pool | A builder bug: use `swap_v2` (`launch.swap`, [below](#native-sol-pools-swap_v2)) |
| `QuoteCutAccountsMissing` (6047) | The coin's hook takes a SOL cut and the trade left out its four accounts | A builder bug: add `quoteCutExtras` ([above](#coins-whose-hook-takes-a-sol-cut)) |
| `QuoteCutWrongAccount` | One of those four is wrong (another wallet's holding, the state read-only) | A builder bug: pass the signer's own holding |
| An error whose `programId` is the token's custom hook (`launch.customHook`) | The hook refused the transfer | Name the hook. A sell that always fails while buys work is the honeypot pattern ([Hooks](05-hooks-and-risk.md#which-hook-a-token-runs)) |

## Ordinary pools

Tokens can also trade in ordinary DEX pools (no launch, a flat 1% protocol fee), such as a bridged
token's pool. Build those with `swap.swap(keys, args, extras)`. A mint with a token hook needs that
hook's accounts in `extras`, through `tokenHookSlice(await fetchTokenHook(connection, op))`, and
`args.inHookAccounts` / `args.outHookAccounts` say how many belong to each side. Quote them with
`swapOut` from `@bordrless/shared`, after the LP and protocol fees. See
`packages/sdk/src/instructions.ts` for the account list.

## Native SOL pools (`swap_v2`)

**Detect**: `decodePool(data).quoteNative` (`Pool.reserved[0] == 1`), or `decodeLaunch(data).isNative`
for a launch. `launchKeysOf(launch)` sets `keys.native` from a decoded native launch, and then
`launch.swap` builds `swap_v2` by itself:

```ts
import { decodeLaunch, launch, launchKeysOf, router } from '@bordrless/sdk';

const l = decodeLaunch(launchInfo.data);
const keys = launchKeysOf(l, customHook);             // keys.native === true on a native launch
const ix = launch.swap(keys, trader, trader, 1, lamportsIn, minOut); // swap_v2: the wallet pays SOL
// A sell (direction 0) delivers SOL to the recipient's wallet. No wrapSol / unwrapSol around it.
// Explicitly: launch.swapV2(keys, …), swap.swapV2({...}, args, extras), swap.swapFor(pool, …).
// The old instruction on any launch: launch.swapClassic(keys, …).
const routed = router.swapV2(trader, integratorWallet, dexTreasury, ix, 50); // fee in SOL to wallets
```

`swap_v2`'s accounts are `swap`'s without the quote vault, with the trader's wallet (buy) or the
receiving wallet (sell) as the quote account (never a token holding), the System Program and five
optional bridge accounts; the remaining accounts are the same slices as `swap`
([Without TypeScript](07-other-languages.md#native-sol-swap_v2)). `minAmountOut` on a sell is in
lamports delivered.

**Pass the bridge accounts only when a cut needs wrapping**: on a launch pool, only when the pool is
native and its launch is not (a held or half-migrated coin). They are the bridge's global SOL
wrapper, SOL vault and bridged-SOL mint: passing them on every trade write-locks those accounts and
serializes your trades with everyone else's. `launch.swapV2` decides this from `keys.native`.

**`launch.swap` changed in 0.14.0 (breaking for callers that wrap).** It builds `swap_v2` for a native
launch: the wallet pays a buy in SOL, a sell delivers SOL to the wallet. If you wrap SOL before
calling it, that bridged SOL is now left unspent in the trader's holding (no loss), and wrapping a
native launch's swap with `router.swap` throws: use `router.swapV2`. **Escape hatch:**
`launch.swapClassic(keys, …)` always builds the classic `swap`.

**The old `swap` keeps working** on a native pool, with the same accounts, through a bridged-SOL
buffer in the old quote vault. A **sell** is paid from the buffer as far as it goes and **the rest as
SOL to the trader's wallet**, which must be writable (the SDK passes it writable; a fee payer always
is), but only when the swap is a **top-level instruction** (not a CPI from your program or the
router's old `swap`), the trader **owns the delivery holding** (not a delegate), and the coin's
**launch is native** too (a held or half-migrated coin's fees go to bridged holdings, which only the
buffer pays). Otherwise a sell the buffer can't cover fails with `BufferShort`, nothing moved. Part
of the proceeds can arrive as SOL rather than bridged SOL (`Swapped.deliveredOut` counts both).
`remove_liquidity` does the same for the provider (top level, the provider owning the quote
holding). `launch.swap` builds `swap_v2` for every native pool, held coins included: pass
`launchKeysOf(launch, hook, { poolNative: pool.quoteNative })`.
An old-path **buy** on a native launch pool pays the launch's fees in SOL from the pool, so on a
fresh native launch pool with no SOL yet it fails with `LamportsShort` until a `swap_v2` trade.
Move to `swap_v2`.

Quoting is unchanged: the reserves are the pool's books (`quoteReserve`, virtual reserves), never
the vault's balance. What a wallet can spend on a buy is its lamports (`spendableQuote`).

## Token-quoted pools (`swap_spl`)

Since 20 Oct 2026 (SDK 0.19.0) a coin may launch against one to six SPL Token or Token-2022 mints
instead of SOL (bordrless-programs `docs/token-quotes.md`). Each mint is a leg: a DEX pool of quote
kind 2 (`Pool.quoteKind`, `isSplPool`, `Pool.splQuote` for the mint's program and decimals) holding
an equal share of the coin's supply, opening at the same market cap in every token, never
graduating. Such a launch has `Launch.tokenQuoted` set and `decodeLegs(legsAddress(mint))` lists its
legs; trading opens only once every leg is open.

- Trade a leg with `swap_spl`: `tokenLaunch.legSwap(keys, trader, recipient, direction, amountIn,
  minAmountOut, rules)` (or `legSwapWith` to name the token accounts), where `keys` is a `LegKeys` (`mint`,
  `quoteMint`, `quoteProgram`, `lpFeeBps`). A buy pays from the trader's associated token account of
  the quote; a sell delivers to the recipient's. The classic `swap` and `swap_v2` refuse a kind-2
  pool.
- Amounts on the quote side are in the leg's token, in its own decimals, not lamports. The creator
  fee is taken in that token too (`legSwapCutsOf` reads it from `Swapped`).
- A buy from a token account with CPI Guard on, or a sell into one that requires memos, fails in the
  DEX: `spl.ts`'s `cpiGuardLocked` and `memoTransferRequired` tell you first.
- Rules (since 21 Oct 2026, SDK 0.19.1): a token-quoted coin may carry the burn, max wallet, the
  creator lock and the early-buyer lock. Such a coin's mint has the kit as its hook: pass the launch's
  `rules` to `legSwap` / `legSwapWith` and they add the coin's hook slice (`legsHookSlice`; 25
  accounts, `LEG_SWAP_ACCOUNTS_WITH_KIT`) and pass the mint writable when a rule burns. A coin
  without rules has no hook and trades with the 20 accounts above. Its locks run from when trading
  opened (`lockTimesInForce`; the `TokenLaunchLocks` event names them).
- Since SDK 0.20.0 a token-quoted coin may also have a companion (the presets and Workshop items
  that opt in), holder rewards paid in a leg's token or as SOL, and the Lottery, Jackpot, Streak or
  Lossback run per leg (bordrless-programs `docs/token-quotes.md` §7). Its trades still go through
  `swap_spl` on its legs. A coin whose token hook is a custom one (a game's or Lossback's) passes that
  hook's slice with `tokenLaunch.legSwapWithSlice(…, customHookSlice(…), baseMintWritable)`;
  `legSwap` adds only the kit's. The router (`router.swap`, `router.swapV2`) doesn't wrap `swap_spl`.

## Sending

Let the user's wallet **sign and send** (`signAndSendTransaction`) wherever you can. Some wallets'
scanners flag apps that ask only for a signature and send it elsewhere. The transaction contains no
signer but the user.
