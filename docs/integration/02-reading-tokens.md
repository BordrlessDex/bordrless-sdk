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
symbol, URI, supply, the curve, the rules, the hook and the creator, so you need no other read
(a creator equal to `companionCreatorAddress(mint)` is a [companion](#creators-that-are-programs-companions)).

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

What it returns, in shape (illustrative values for a token on the Half-Life hook, about 9% of the
way along its curve):

```
name: '<name>', symbol: '<symbol>', decimals: 6, supply: '1000000000',
priceSol: 6.03e-8, marketCapSol: 60.3, liquiditySol: '9.0', curveProgress: 0.093,
lpFeeBpsNow: 30, creatorFeeBps: 100, protocolShareBps: 2500,
tokenHook: 'Half-Life (exit fee halving every 6 h held)', trades: '71'
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
| `companionCreatorAddress(mint)` | A companion coin's creator: the launcher's dev buy, still vesting (below) |

## Creators that are programs: companions

A launch's `creator` can be a **companion**: a Bordrless program (`6ZUM1g…sJuo`) that made the
launch and receives every creator fee, so the fees are spent only by its code (bought back and
burned, shared with holders, paid to the launcher, or a game's pot), with no person holding them.
Tell from the creator alone, with no read:

```ts
import { companionAddress, companionCreatorAddress, decodeCompanion, decodeGame, gameAddress } from '@bordrless/sdk';

const isCompanion = launch.creator.equals(companionCreatorAddress(mint));
if (isCompanion) {
  const [companionInfo, gameInfo] = await connection.getMultipleAccountsInfo([companionAddress(mint), gameAddress(mint)]);
  const companion = decodeCompanion(companionInfo!.data);
  // companion.split (buybackBps, holdersBps, beneficiaryBps), companion.beneficiary (who launched it),
  // the dev buy: companion.devTokens, vesting over companion.vestSecs, companion.devReleased so far
  const game = companion.gameHook && gameInfo ? decodeGame(gameInfo.data) : null;
  // game?.kind: 'lottery' | 'jackpot' | 'streak'; the pot is companion.pendingPot (lamports)
}
```

Label it "Creator: companion (fees run by a program)" rather than a wallet. Its parts:

- **The split** of every fee claim, fixed when the companion was made: `buybackBps` (the token is
  bought on its own pool and burned), `holdersBps` (shared with holders through the kit's holder
  rewards), `beneficiaryBps` (paid to `beneficiary`), and for a game `potBps`. They sum to
  10,000.
- **The dev buy**: the launcher's own buy is held by the companion at `companionCreatorAddress(mint)`
  and vests linearly over `vestSecs` from the launch (`companionVested(companion, now)`). Count
  `devTokens - devReleased` as the dev's, locked.
- **Buybacks** are swaps whose `trader` is `companionCreatorAddress(mint)` (so is the dev buy); the
  tokens a buyback buys are burned in the same instruction. Label them, rather than counting them
  as organic buys.
- The creator address's bridged SOL is fees waiting to be spent (`pendingBuyback`,
  `pendingBeneficiary`, `pendingPot`): it is not liquidity.

Every step but the dev buy is permissionless and pays its sender a small bounty. The design:
[docs/companions.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/companions.md).
`Companion.gameKind` reads `'lottery'` on a companion without a game, so check `gameHook` first.

### Game coins

A companion with a game (`companion.gameHook` set) runs a **lottery**, a **jackpot** or a
**streak**, paid in SOL from its pot:

| Kind | Who is paid | Token hook |
| --- | --- | --- |
| `lottery` | Each round, a holder drawn by ORAO VRF, weighted by tokens held since the round began | Bordrless's lottery hook `HqFWsC…GWcr` |
| `jackpot` | The last buyer of at least `game.minTokens` on the bonding curve, when `game.timerSecs` pass with no qualifying buy, if they have sent nothing since | A Studio-deployed hook, one per coin |
| `streak` | Each epoch, the holders who held through it without sending anything, pro rata | A Studio-deployed hook, one per coin |

For the coin's page: the pot (`companion.pendingPot`), the share it pays (`game.prizeBps` of the
pot, from `game.minPot`), the round or epoch length (`game.roundSecs`), and the kind's settings.
Until the protocol says otherwise for a hook, a pot is capped at 10 SOL; the hook's status, if any,
is at `hookStatusAddress(game.hook)` (`decodeHookStatus`, `hookPotCap(hookTermsOf(status))`).
Game coins have no holder rewards and no kit rules. Rounds, draws, settles and claims, and what
each can't do: [docs/games.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/games.md).
A lottery draw's randomness is verifiable and comes from ORAO VRF: ORAO's three signers produce
it, and they could withhold or bias a draw; Bordrless can't. What wallets can offer holders:
[Hooks](05-hooks-and-risk.md#game-coins).

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
