# Integrating the Bordrless token standard

For trading terminals, aggregators, indexers, wallets and portfolio trackers that want to show and
trade Bordrless tokens.

Bordrless tokens are **not SPL or Token-2022 tokens**. They live in their own token program, built
for hooks, and trade on the Bordrless DEX. Your existing SPL code won't see them: wallets don't
list them, `getTokenAccountsByOwner` doesn't return them, and Jupiter doesn't route them. Everything
here is public and permissionless: read the chain, build transactions with
[`@bordrless/sdk`](../../packages/sdk), and send them yourself.

```sh
npm install @bordrless/sdk @bordrless/shared @solana/web3.js
```

## The guides

| Guide | You'll learn |
| --- | --- |
| [1. The standard](01-the-standard.md) | How tokens, holdings, pools and launches fit together; program ids; account layouts and discriminators |
| [2. Reading tokens](02-reading-tokens.md) | Finding every token, metadata, price, market cap, liquidity, curve progress, holders, a wallet's balances |
| [3. Indexing trades](03-indexing-trades.md) | Decoding `Swapped` and every other event, streaming new launches and trades, candles |
| [4. Trading](04-trading.md) | Quoting exactly, building buys and sells, slippage, graduation, priority fees, errors |
| [5. Hooks and what to show users](05-hooks-and-risk.md) | Launch rules, custom hooks, Half-Life, which tokens can refuse or tax a transfer |
| [6. The bridge](06-bridge.md) | Bridged SOL (the quote of every launch) and wrapping SPL tokens one for one |
| [7. Without TypeScript](07-other-languages.md) | Raw layouts, instruction data and the Rust client crates |

## Runnable examples

Every snippet in these guides is taken from [`examples/`](../../examples). Each example is
read-only and was run against mainnet:

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
| Bridged SOL (quote of every launch) | `A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i` |
| Protocol lookup table | `4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ` |

The programs are verified builds of
[bordrless-programs](https://github.com/BordrlessDex/bordrless-programs), which has the full
protocol spec (`docs/hooks-v2.md`) and the IDLs. They are upgradeable until audited: check
`solana program show <address>`.

## Need help, or an API key?

Bordrless runs an indexer and an HTTP API (launches, trades, candles, holders, quotes and prepared
transactions). It needs a key; ask the team. For a security issue, use the programs repo's
[security advisories](https://github.com/BordrlessDex/bordrless-programs/security/advisories/new).
