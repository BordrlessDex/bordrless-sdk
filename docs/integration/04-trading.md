# 4. Trading

Quote a trade, build it, let the user's wallet sign and send it. All of it is permissionless; there
is no Bordrless API in the path.

Launch pools trade against **bridged SOL**, an SPL-free 1:1 wrapper of SOL on the Bordrless bridge.
A buy with SOL therefore wraps the SOL first, and a sell unwraps it after, in the same transaction.

> **Native SOL (coming; timeline TBD).** Pools are moving to hold SOL as lamports on the pool
> account (bordrless-programs `docs/native-sol-migration.md`). A native pool keeps its address and
> its `quote_mint`; trade it with `swap_v2`: no wrap, no unwrap, no bridged-SOL holding. See
> [Native SOL pools](#native-sol-pools-swap_v2) below. Everything on this page keeps working for
> bridged pools.

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
const keys = launchKeysOf(launch, customHook);
const ixs = [
  setComputeUnitLimit(400_000), setComputeUnitPrice(priorityMicroLamports), // or the simulated units + 15%
  token.createHolding(wallet, launch.quoteMint, wallet),     // its bridged-SOL holding (idempotent)
  bridge.wrapSol(wallet, lamports),                          // SOL -> bridged SOL
  token.createHolding(wallet, mint, wallet),                 // its holding of the token (idempotent)
  launchIx.swap(keys, wallet, wallet, 1, lamports, minOut),  // direction 1 = buy
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

Same shape, direction 0, the token amount in, and unwrap after:

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
the bridged SOL the wallet receives.

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
rest of the input in the buyer's bridged-SOL holding; `graduate` can follow in the same transaction.

- `Swapped.amountIn` is the part used; the instruction's `amount_in` is only what was offered.
- Append `bridge.unwrapSolAbove(wallet, bridgedBefore)` after such a buy to return the rest as SOL
  (it refuses to unwrap nothing, so add it only where the buy may pass the end).
- `minAmountOut` is held pro rata (`delivered >= min * used / offered`): give the least you accept
  for the whole input at the quoted rate. A minimum from a quote that pretends the curve goes on
  fails as `Slippage` (6017).
- The fill is the launchpad's and only for a swap your transaction sends the DEX itself. A program
  that calls the DEX (your router program, a companion) gets none, and a curve another program opens
  never fills (`BadFill`, 6038): there a buy past the end still fails with `InsufficientLiquidity`.
- Give the transaction about 275,000 compute units: a filled buy with its wrap and holdings is
  above the 200,000 default.
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
- **Rent:** a wallet's first trade of a token creates its holding (about 0.0023 SOL), and the
  first buy with SOL creates its bridged-SOL holding too.
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

**The old `swap` keeps working** on a native pool through a small bridged-SOL buffer in the old
quote vault, with a limit: **a sell fails with `BufferShort`** when the buffer can't cover it
(`classicSellCapacity(pool)` says how much it can), and an old-path buy on a pool with no lamports
yet can fail with `LamportsShort`. Move to `swap_v2`.

Quoting is unchanged: the reserves are the pool's books (`quoteReserve`, virtual reserves), never
the vault's balance. What a wallet can spend on a buy is its lamports (`spendableQuote`).

## Sending

Let the user's wallet **sign and send** (`signAndSendTransaction`) wherever you can. Some wallets'
scanners flag apps that ask only for a signature and send it elsewhere. The transaction contains no
signer but the user.
