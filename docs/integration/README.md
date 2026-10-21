# Integrating the Bordrless token standard

For trading terminals, aggregators, indexers, wallets and portfolio trackers that want to show and
trade Bordrless tokens.

**Changed 2026-10-20 (SDK 0.19.0): quote tokens.** A coin may now launch against one to six SPL
Token or Token-2022 mints instead of SOL. Each mint is its own DEX pool (a "leg", quote kind 2)
holding an equal share of the supply; a coin is quoted in SOL or in its tokens, never both, and SOL
launches are unchanged. Read `Pool.quoteKind` / `isSplPool(pool)` and `Launch.tokenQuoted` rather
than assuming SOL: a kind-2 pool trades only with `swap_spl` (the classic `swap` and `swap_v2`
refuse it), its quote side is in that token, and it still emits `Swapped`. Since 21 Oct 2026 (SDK
0.19.1) such a coin may carry the burn, max wallet and the locks, and then its swaps pass the kit's
hook slice
([Trading](04-trading.md#token-quoted-pools-swap_spl); the spec is bordrless-programs
`docs/token-quotes.md`).

**Changed 2026-10-15 and 16 (SDK 0.14.0): native SOL.** Pools, launches, kits, companions and hook
vaults hold SOL as lamports (pools keep bridged SOL `A49oVh…` as their `quote_mint` and in their
seeds, so no address changed). Trade them with `swap_v2`: the wallet pays a buy in SOL and a sell
pays SOL to the wallet, **no wrap and no unwrap**; `launch.swap` builds it for native pools. New
launches are native since 16 Oct 2026. Two exceptions stay on bridged SOL: pool
`4PvPnTByfrnhA1nNmsaou7GrdQsqJNrkinqLHp2JHFX7` (forever) and, for now, the coin
`5DMBPNoYAmbiNnRyRkWS7BetnfvAzbUqXyXNiw6Hn7hh`. Read `quoteNative` / `isNative` rather than
assuming either ([Trading](04-trading.md#native-sol-pools-swap_v2)).

**Changed 2026-10-13 (SDK 0.10.0):** apps can charge their own fee on swaps they route (the
router: at most 1%, `router.swap`); a custom hook may take a SOL cut on every trade of its coin, so
a trade on such a coin passes four more accounts (`launch.swap` adds them; `quoteCutExtras`);
companions may share their beneficiary part with up to 10 payees, and scripts may pay any wallet SOL
when their launcher allowed it. Full list: [CHANGELOG](../../packages/sdk/CHANGELOG.md).

**Changed 2026-10-12 (SDK 0.9.0):** Snowball (a companion that trades its pot on the token's own
pool), script companions and their approvals, a custom hook beside any companion, five-minute
lottery rounds, and `tokenBalanceChanges` / `holdingBalanceChanges` for pre/post balances of
Bordrless holdings. Full list: [CHANGELOG](../../packages/sdk/CHANGELOG.md).

**Changed 2026-10-10 (SDK 0.8.0):** a custom hook may now also be **timelocked** by its author (new
code only after at least 3 days of public notice). Show one risk label per hooked token, from
`hookRiskLabel` ([Hooks](05-hooks-and-risk.md#risk-labels)). Strategy coins and the hook vault are
live; vault slots hold tokens and should be labelled, not counted as holders
([Hooks](05-hooks-and-risk.md#strategy-coins-and-the-hook-vault)).

**Changed 2026-10-09 (SDK 0.6.0 and 0.7.0):** companion v2 and game coins are live on mainnet:
lottery coins on Bordrless's lottery hook (three lottery launch configs), jackpot and streak coins
on per-coin hooks written with Bordrless Studio. A coin's creator can be a companion program
([Reading tokens](02-reading-tokens.md#creators-that-are-programs-companions)); a custom hook must
be immutable or upgradeable only by Bordrless ([Hooks](05-hooks-and-risk.md#who-can-upgrade-a-hook));
new events to index ([Indexing](03-indexing-trades.md#companion-and-game-events)).

Bordrless tokens are **not SPL or Token-2022 tokens**. They live in their own token program, built
for hooks, and trade on the Bordrless DEX. Your existing SPL code won't see them: wallets don't
list them, `getTokenAccountsByOwner` doesn't return them, and Jupiter doesn't route them. Everything
here is public and permissionless: read the chain, build transactions with
[`@bordrless/sdk`](../../packages/sdk), and send them yourself.

```sh
npm install @bordrless/sdk@0.14.0 @bordrless/shared@0.14.0 @solana/web3.js
```

## Integration checklist

For a terminal that lists, prices and trades Bordrless tokens:

1. **Detect a Bordrless token**: its mint is owned by the token program `2XoEW…vr22`, and a
   launchpad token has a `Launch` at `launchAddress(mint)`
   ([The standard](01-the-standard.md#tokens-and-holdings), [Every launch](02-reading-tokens.md#every-launch)).
2. **Price it** from its pool's real plus virtual reserves (the pool's books, in SOL, whichever form
   the pool is in; never a vault's balance) ([One token's page](02-reading-tokens.md#one-tokens-page)).
3. **Quote and simulate** every swap: `quoteLaunchSwap` is exact for launch rules; simulate any
   token with a custom hook ([Quoting exactly](04-trading.md#quoting-exactly)).
4. **Build and send**: `launch.swap` (`swap_v2` on a native pool: SOL straight from and to the
   wallet, no wrap; only a bridged pool wraps and unwraps in the same transaction), pass the hook's accounts (four
   more on a coin whose hook takes a SOL cut, [Trading](04-trading.md#coins-whose-hook-takes-a-sol-cut)), use a
   v0 transaction with the protocol lookup table, set a compute-unit limit from the simulation, and
   let the wallet sign and send ([A buy, end to end](04-trading.md#a-buy-end-to-end),
   [Fees and compute](04-trading.md#fees-and-compute), [Sending](04-trading.md#sending)).
5. **Label creators and hooks**: a creator may be a companion program, a coin may run a game, and
   a custom hook may refuse or tax transfers; show who can upgrade the hook
   ([Companions](02-reading-tokens.md#creators-that-are-programs-companions),
   [Which hook a token runs](05-hooks-and-risk.md#which-hook-a-token-runs),
   [Who can upgrade a hook](05-hooks-and-risk.md#who-can-upgrade-a-hook), [Risk labels](05-hooks-and-risk.md#risk-labels)).
6. **Index** trades, fees and launches from event CPIs, not logs; skip failed transactions
   ([Indexing trades](03-indexing-trades.md)).
7. **Handle bridged SOL** left over: show a wallet's bridged-SOL holding as SOL that can be unwrapped
   ([The bridge](06-bridge.md#bridged-sol)).
8. **Native SOL** (live since 15 Oct 2026; new launches native since 16 Oct): detect `quoteNative` / `isNative`, trade native
   pools with `swap_v2` (an old `swap` sell the buffer can't cover is paid the rest in SOL only when
   sent top level by the holding's owner on a native launch; otherwise it fails with `BufferShort`), index `SwappedNative`, read SOL as lamports where the flags say so
   ([Native SOL pools](04-trading.md#native-sol-pools-swap_v2), [Indexing](03-indexing-trades.md#native-sol-swaps-swap_v2),
   [Reading](02-reading-tokens.md#native-sol)).

## The guides

| Guide | You'll learn |
| --- | --- |
| [1. The standard](01-the-standard.md) | How tokens, holdings, pools and launches fit together; program ids; account layouts and discriminators |
| [2. Reading tokens](02-reading-tokens.md) | Finding every token, metadata, price, market cap, liquidity, curve progress, holders, a wallet's balances, companion creators and game coins |
| [3. Indexing trades](03-indexing-trades.md) | Decoding `Swapped` and every other event, streaming new launches and trades, candles, companion and game events |
| [4. Trading](04-trading.md) | Quoting exactly, building buys and sells, slippage, graduation, compute and priority fees, errors |
| [5. Hooks and what to show users](05-hooks-and-risk.md) | Launch rules, custom hooks, Half-Life, game hooks, Studio hooks, who can upgrade a hook, risk labels, strategies and the vault, which tokens can refuse or tax a transfer |
| [6. The bridge](06-bridge.md) | Bridged SOL (the `quote_mint` of every launch, held as native SOL by almost every pool) and wrapping SPL tokens one for one |
| [7. Without TypeScript](07-other-languages.md) | Raw layouts, instruction data and the Rust client crates |

## Runnable examples

The snippets in these guides come from [`examples/`](../../examples) or are checked against the
SDK. Each example is read-only and was run against mainnet:

| Example | Does |
| --- | --- |
| [`list-launches.ts`](../../examples/list-launches.ts) | Every launch, newest first |
| [`read-launch.ts`](../../examples/read-launch.ts) | One token: metadata, price, market cap, curve progress, fees, rules, hook |
| [`recent-trades.ts`](../../examples/recent-trades.ts) | A token's latest trades, decoded from its pool's transactions |
| [`wallet-holdings.ts`](../../examples/wallet-holdings.ts) | Every Bordrless token a wallet holds |
| [`quote-buy.ts`](../../examples/quote-buy.ts) | Quote a buy, build the transaction, simulate it, compare |

```sh
git clone https://github.com/BordrlessDex/bordrless-sdk && cd bordrless-sdk
pnpm install && pnpm build
RPC_URL=<your mainnet RPC> node examples/read-launch.ts <MINT>
```

Node 23.6 or later runs the `.ts` files directly (Node 22.6+ with `--experimental-strip-types`). Use your own RPC: the public one rate-limits
`getProgramAccounts`.

## Mainnet at a glance

| | Address |
| --- | --- |
| Token program | `2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22` |
| DEX | `GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk` |
| Launchpad | `1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC` |
| Bridge | `CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7` |
| Kit (launch rules hook) | `14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH` |
| Half-Life hook | `53SpmtkdPWQ63mWoDeXk8P9tuwiT4ed2Wx4fwfy5NSF8` |
| Companion (a launch's creator as a program; game coins) | `6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo` |
| Lottery hook | `HqFWsCBQ416DAfevJ9TspyT5yXGGoYTCpcreiGkCgWcr` |
| Bridged SOL (every launch's `quote_mint`; native pools hold lamports) | `A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i` |
| Router (an app's integrator fee) | `7M5GTuzhByzBbrJURzLtbBrFjcsC8aHu816qWTXAYD85` |
| Protocol lookup table | `4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ` |

The programs are verified builds of
[bordrless-programs](https://github.com/BordrlessDex/bordrless-programs), which has the full
protocol spec (`docs/hooks-v2.md`), the companion and game references (`docs/companions.md`,
`docs/games.md`) and the IDLs. Every program above but the token program is upgradeable by one key,
the protocol's `5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd`; the token program's upgrade
authority is a Squads multisig vault, `5wni4K2qdSfTr6JspbLXDStfbq1XSmzMpF75RSpwsjBH` (7-day time
lock) (read from mainnet on 2026-10-18): check `solana program show <address>`.

## Need help, or an API key?

Bordrless runs an indexer and an HTTP API (launches, trades, candles, holders, quotes and prepared
transactions). It needs a key; ask the team. For a security issue, use the programs repo's
[security advisories](https://github.com/BordrlessDex/bordrless-programs/security/advisories/new).
