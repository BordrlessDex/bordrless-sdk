# 2. Reading tokens

Everything a token list, a token page and a portfolio view need, straight from the chain.

## Every launch

`Launch` accounts are owned by the launchpad and start with their discriminator, so one
`getProgramAccounts` finds them all. Read their mints in one batch for names and symbols.
From [`list-launches.ts`](../../examples/list-launches.ts):

```ts
import { CODERS, LAUNCH_PROGRAM, decodeLaunch, decodeMany, decodeMint } from '@bordrless/sdk';

const filter = CODERS.launch.accounts.memcmp('launch'); // the Launch discriminator at offset 0
const accounts = await connection.getProgramAccounts(LAUNCH_PROGRAM, {
  filters: [{ memcmp: { offset: filter.offset ?? 0, bytes: filter.bytes! } }],
});
const launches = accounts.map((a) => decodeLaunch(a.account.data));
const mints = decodeMany(await connection.getMultipleAccountsInfo(launches.map((l) => l.mint)), decodeMint);
```

For a live feed of new tokens, don't poll: decode `LaunchCreated` events from the launchpad's
transactions ([Indexing trades](03-indexing-trades.md#new-launches)). That event carries the name,
symbol, URI, supply, the curve, the rules and the hook, so you need no other read.

A token that isn't a launch (minted directly with `token.createMint`, or a bridged SPL token) has a
`Mint` but no `Launch`. Find mints with `getProgramAccounts` on the token program, filtered by the
`Mint` discriminator `50bcf5145f8a399c`.

## One token's page

Three reads: the mint, its launch, and the launch's pool. From
[`read-launch.ts`](../../examples/read-launch.ts):

```ts
import { SOL_DECIMALS, sniperLpFee, spotPrice } from '@bordrless/shared';
import { decodeLaunch, decodeMint, decodePool, launchAddress } from '@bordrless/sdk';

const [mintInfo, launchInfo] = await connection.getMultipleAccountsInfo([mint, launchAddress(mint)]);
const token = decodeMint(mintInfo!.data);
const launch = decodeLaunch(launchInfo!.data);
const pool = decodePool((await connection.getAccountInfo(launch.pool))!.data);

const price = spotPrice(pool, token.decimals, SOL_DECIMALS);           // SOL per whole token
const marketCap = price * Number(token.supply) / 10 ** token.decimals;  // in SOL
const liquidity = Number(pool.quoteReserve) / 1e9;                      // real SOL in the pool
const progress = launch.status === 1 ? 1 : Number(pool.quoteReserve) / Number(launch.graduationQuote);
const lpFeeNow = sniperLpFee(now, launch.createdAt, launch.sniperWindowSecs, launch.sniperStartBps, launch.lpFeeBps);
```

What a live token returned, a Half-Life token 14% of the way along its curve:

```
name: 'Half Life', symbol: 'hLife', decimals: 6, supply: '1000000000',
priceSol: 7.22e-8, marketCapSol: 72.2, liquiditySol: '14.374', curveProgress: 0.1488,
lpFeeBpsNow: 30, creatorFeeBps: 100, protocolShareBps: 2500,
tokenHook: 'Half-Life (exit fee halving every 6 h held)', trades: '16'
```

Notes:

- **Use `token.supply`, not 1,000,000,000.** Burns (the burn rule, Half-Life's furnace, the
  reserve's remainder at graduation) lower it.
- **Price includes the virtual reserves.** That's the curve's price. After graduation the virtual
  reserves are zero, and the formula still holds.
- **Liquidity** is the real SOL in the pool (`quoteReserve`). Protocol fees waiting to be collected
  (a launch pool's LP fee among them) sit in the same vault but are tracked apart
  (`protocolFeesQuote`): don't count them. Anyone may pay them out to Bordrless as SOL with
  `swap.collectProtocolFeesSol(cranker, pool, feeCollector)`.
- **USD** is the SOL price times these figures. Bridged SOL is SOL one for one
  ([The bridge](06-bridge.md)).
- **The pool's own totals** cover volume and activity without an indexer: `swapCount`,
  `baseVolume`, `quoteVolume`, `lastSwapAt`.

## Holders

Every holding of a mint is a 204-byte account with the mint at byte 10:

```ts
import { HOLDING_SIZE, TOKEN_PROGRAM, decodeHolding } from '@bordrless/sdk';

const holdings = await connection.getProgramAccounts(TOKEN_PROGRAM, {
  filters: [{ dataSize: HOLDING_SIZE }, { memcmp: { offset: 10, bytes: mint.toBase58() } }],
});
const top = holdings
  .map((h) => decodeHolding(h.account.data))
  .filter((h) => h.amount > 0n)
  .sort((a, b) => (b.amount > a.amount ? 1 : -1));
```

Some holders aren't people. Label or exclude them:

| Owner | What it is |
| --- | --- |
| `launch.pool` | The pool's token vault: the liquidity |
| `launchAddress(mint)` | The launch's reserve, until graduation |
| `halfLifeFurnaceOwner(mint)` | A Half-Life token's furnace (tokens waiting to be burned) |

## A wallet's balances

Wallets and `getTokenAccountsByOwner` don't see Bordrless tokens. Filter holdings by owner (byte
42). From [`wallet-holdings.ts`](../../examples/wallet-holdings.ts):

```ts
const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM, {
  filters: [{ dataSize: HOLDING_SIZE }, { memcmp: { offset: 42, bytes: owner.toBase58() } }],
});
const holdings = accounts.map((a) => decodeHolding(a.account.data)).filter((h) => h.amount > 0n);
const mints = decodeMany(await connection.getMultipleAccountsInfo(holdings.map((h) => h.mint)), decodeMint);
```

For one known token, read `holdingAddress(mint, owner)` directly; it's a PDA, no search needed. A
holding of `BRIDGED_SOL_MINT` is the wallet's bridged SOL: show it as SOL that can be unwrapped
([The bridge](06-bridge.md)).

## Freshness

Accounts change with every trade. For prices, either re-read the pool, or take the reserves from
each `Swapped` event, which carries the pool's reserves after the trade
([Indexing trades](03-indexing-trades.md)). Subscribing to the pool account (`onAccountChange`) and
decoding with `decodePool` works too.
