# Integrating the Bordrless token standard

For trading terminals, aggregators, indexers, wallets and portfolio trackers that want to show and
trade Bordrless tokens.

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
npm install @bordrless/sdk@0.7.0 @bordrless/shared@0.7.0 @solana/web3.js
```

## Integration checklist

For a terminal that lists, prices and trades Bordrless tokens:

1. **Detect a Bordrless token**: its mint is owned by the token program `2XoEW…vr22`, and a
   launchpad token has a `Launch` at `launchAddress(mint)`
   ([The standard](01-the-standard.md#tokens-and-holdings), [Every launch](02-reading-tokens.md#every-launch)).
2. **Price it** from its pool's real plus virtual reserves, in bridged SOL (1:1 with SOL)
   ([One token's page](02-reading-tokens.md#one-tokens-page)).
3. **Quote and simulate** every swap: `quoteLaunchSwap` is exact for launch rules; simulate any
   token with a custom hook ([Quoting exactly](04-trading.md#quoting-exactly)).
4. **Build and send**: wrap or unwrap SOL in the same transaction, pass the hook's accounts, use a
   v0 transaction with the protocol lookup table, set a compute-unit limit from the simulation, and
   let the wallet sign and send ([A buy, end to end](04-trading.md#a-buy-end-to-end),
   [Fees and compute](04-trading.md#fees-and-compute), [Sending](04-trading.md#sending)).
5. **Label creators and hooks**: a creator may be a companion program, a coin may run a game, and
   a custom hook may refuse or tax transfers; show who can upgrade the hook
   ([Companions](02-reading-tokens.md#creators-that-are-programs-companions),
   [Which hook a token runs](05-hooks-and-risk.md#which-hook-a-token-runs),
   [Who can upgrade a hook](05-hooks-and-risk.md#who-can-upgrade-a-hook)).
6. **Index** trades, fees and launches from event CPIs, not logs; skip failed transactions
   ([Indexing trades](03-indexing-trades.md)).
7. **Handle bridged SOL**: show a wallet's bridged-SOL holding as SOL; unwrap sell proceeds
   ([The bridge](06-bridge.md#bridged-sol)).

## The guides

| Guide | You'll learn |
| --- | --- |
| [1. The standard](01-the-standard.md) | How tokens, holdings, pools and launches fit together; program ids; account layouts and discriminators |
| [2. Reading tokens](02-reading-tokens.md) | Finding every token, metadata, price, market cap, liquidity, curve progress, holders, a wallet's balances, companion creators and game coins |
| [3. Indexing trades](03-indexing-trades.md) | Decoding `Swapped` and every other event, streaming new launches and trades, candles, companion and game events |
| [4. Trading](04-trading.md) | Quoting exactly, building buys and sells, slippage, graduation, compute and priority fees, errors |
| [5. Hooks and what to show users](05-hooks-and-risk.md) | Launch rules, custom hooks, Half-Life, game hooks, Studio hooks, who can upgrade a hook, which tokens can refuse or tax a transfer |
| [6. The bridge](06-bridge.md) | Bridged SOL (the quote of every launch) and wrapping SPL tokens one for one |
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
RPC_URL=<your mainnet RPC> node examples/read-launch.ts BWgqmV24qL5fFXMBhb77z3Moce8BYHKB7UzDZ11imB5X
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
| Bridged SOL (quote of every launch) | `A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i` |
| Protocol lookup table | `4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ` |

The programs are verified builds of
[bordrless-programs](https://github.com/BordrlessDex/bordrless-programs), which has the full
protocol spec (`docs/hooks-v2.md`), the companion and game references (`docs/companions.md`,
`docs/games.md`) and the IDLs. Every program above is upgradeable by one key, the protocol's
`5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd` (read from mainnet on 2026-10-09): check
`solana program show <address>`.

## Need help, or an API key?

Bordrless runs an indexer and an HTTP API (launches, trades, candles, holders, quotes and prepared
transactions). It needs a key; ask the team. For a security issue, use the programs repo's
[security advisories](https://github.com/BordrlessDex/bordrless-programs/security/advisories/new).
