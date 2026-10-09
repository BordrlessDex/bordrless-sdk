# 4. Trading

Quote a trade, build it, let the user's wallet sign and send it. All of it is permissionless; there
is no Bordrless API in the path.

Launch pools trade against **bridged SOL**, an SPL-free 1:1 wrapper of SOL on the Bordrless bridge.
A buy with SOL therefore wraps the SOL first, and a sell unwraps it after, in the same transaction.

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
| hLife | Half-Life hook, creator 1% | 1,630,280.020655 | 1,630,280.020655 |
| LIMITLESS | holder rewards 0.5%, creator 0.5% | 2,269,499.301361 | 2,269,499.301361 |
| CTRL | none, creator 1% | 2,287,625.252001 | 2,287,625.252001 |

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

A buy larger than what's left on the curve fails with `InsufficientLiquidity`.
`curveMaxBuyIn(pool, lpFeeBps, protocolShareBps, feeParams)` gives the largest buy the curve can
still fill.

## Fees and compute

- **Compute:** simulate and request the units used plus 15%. A buy with SOL used 136,760
  (CTRL), 152,376 (hLife) and 166,537 (LIMITLESS, holder rewards) compute units in mainnet
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
| An error whose `programId` is the token's custom hook (`launch.customHook`) | The hook refused the transfer | Name the hook. A sell that always fails while buys work is the honeypot pattern ([Hooks](05-hooks-and-risk.md#which-hook-a-token-runs)) |

## Ordinary pools

Tokens can also trade in ordinary DEX pools (no launch, a flat 1% protocol fee), such as a bridged
token's pool. Build those with `swap.swap(keys, args, extras)`. A mint with a token hook needs that
hook's accounts in `extras`, through `tokenHookSlice(await fetchTokenHook(connection, op))`, and
`args.inHookAccounts` / `args.outHookAccounts` say how many belong to each side. Quote them with
`swapOut` from `@bordrless/shared`, after the LP and protocol fees. See
`packages/sdk/src/instructions.ts` for the account list.

## Sending

Let the user's wallet **sign and send** (`signAndSendTransaction`) wherever you can. Some wallets'
scanners flag apps that ask only for a signature and send it elsewhere. The transaction contains no
signer but the user.
