# 3. Indexing trades

Every Bordrless program emits **Anchor event CPIs**: each event is an inner instruction from the
program to its own event authority (`["__event_authority"]`), its data the 8-byte event tag
`e445a52e51cb9a1d`, then the event's discriminator and Borsh body. They're in the transaction's
`meta.innerInstructions`, not its logs, so they survive log truncation.

## Decoding events from a transaction

From [`recent-trades.ts`](../../examples/recent-trades.ts):

```ts
import bs58 from 'bs58';
import { eventsOf, typedEvent, type RawInnerInstruction } from '@bordrless/sdk';

const tx = (await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }))!;
const meta = tx.meta!; // skip the transaction when meta.err is set

// Inner instructions index into the static keys, then the lookup tables' writable, then read-only addresses.
const loaded = meta.loadedAddresses;
const keys = [...tx.transaction.message.staticAccountKeys.map(String), ...(loaded?.writable ?? []).map(String), ...(loaded?.readonly ?? []).map(String)];
const inner = (meta.innerInstructions ?? []).flatMap((g) => g.instructions as RawInnerInstruction[]);

for (const event of eventsOf(keys, inner, (data) => Buffer.from(bs58.decode(data)))) {
  const typed = typedEvent(event);         // null for events without a typed view
  if (typed?.kind === 'swap.Swapped') { /* a trade */ }
}
```

`eventsOf` only reads event CPIs: inner instructions to a Bordrless program whose only account is
that program's event authority and whose data starts with the event tag. Only the program can sign
as its own event authority, so an instruction that fakes an event fails on chain. **Skip failed
transactions** (`tx.meta.err`): their events never happened. Most Bordrless transactions use the
protocol lookup table, so **always include the loaded addresses** in the key list.

## `Swapped`: a trade

| Field | Meaning |
| --- | --- |
| `pool`, `trader`, `recipient` | The pool; who signed; whose holding received the output |
| `direction` | 1 buy (quote in, token out), 0 sell |
| `amountIn` | What left the trader's wallet, in the input token |
| `burnIn`, `cutsIn`, `receivedIn` | From the input: burned, taken by hooks for someone, and what reached the pool |
| `lpFee` | LP fee kept by the pool, in the input token. **0 on launch pools**: their LP fee is Bordrless's and is inside `protocolFee` |
| `protocolFee` | Bordrless's take, **always in the quote (SOL)**. On a launch pool: the LP fee (at `lpFeeBps`) plus 25% of the hooks' cuts |
| `amountOut` | What the curve gave, in the output token |
| `burnOut`, `cutsOut`, `deliveredOut` | From the output: burned, taken by hooks, and what reached the recipient |
| `deltasIn`, `deltasOut` | Each hook cut: the holding it went to and the amount |
| `baseReserve`, `quoteReserve`, `virtualBase`, `virtualQuote` | The pool **after** the trade |
| `swapCount`, `slot`, `ts` | The pool's trade counter, the slot and the unix time |

**Units follow the side.** Input-side fields (`amountIn`, `burnIn`, `cutsIn`, `receivedIn`, `lpFee`)
are in the input token, SOL on a buy and the token on a sell. Output-side fields are in the other
token. `protocolFee` is always SOL. Don't add `cutsIn` to `cutsOut`.

**The LP fee on launch pools.** Since the 2026-10-08 upgrade a launch pool's LP fee goes to
Bordrless in SOL instead of compounding in the pool: on a buy from the SOL that reached the pool,
on a sell from the curve's SOL output. Events from then on carry `lpFee: 0` and the LP fee inside
`protocolFee`; `lpFeeBps` is still the rate charged (the sniper fee included). Earlier events
carry the LP fee in `lpFee`, in the input token. Ordinary pools are unchanged.

What a trade is, as a user saw it:

```ts
const buy = typed.direction === 1;
const solAmount = buy ? typed.amountIn : typed.deliveredOut;    // SOL spent, or SOL received
const tokenAmount = buy ? typed.deliveredOut : typed.amountIn;  // tokens received, or tokens sold
const priceAfter =
  Number(typed.quoteReserve + typed.virtualQuote) / Number(typed.baseReserve + typed.virtualBase) *
  10 ** (tokenDecimals - 9);                                     // SOL per whole token
```

Real output from mainnet (2026-10-08 and 09, after the LP fee change), a buy and a Half-Life sell:

```
BUY   0.5 SOL  8236181.117965 hLife  price after 6.0287e-8 SOL  lp 0 SOL, protocol 0.002735 SOL, hook cuts 0.005 SOL in + 0 hLife out
SELL  0.662457069 SOL  14811734.334883 hLife  price after 5.9255e-8 SOL  lp 0 hLife, protocol 0.046974558 SOL, hook cuts 2876498.054771 hLife in + 0.006708427 SOL out
```

The buy's `cutsIn` is the 1% creator fee. Its `protocolFee` is the 0.3% LP fee on the 0.495 SOL
that reached the pool plus 25% of the creator fee. The sell's `cutsIn` is Half-Life's exit fee:
the seller had held for 21 minutes, so about 19.4% of the tokens they sold went to the furnace; its
`cutsOut` is the 1% creator fee on the SOL out, and its `protocolFee` the LP fee plus 25% of both
cuts' value in SOL. Use `deliveredOut` and `amountIn` for what the user actually got and gave. The
pool price moved by `receivedIn` after fees, not by `amountIn`.

**Volume:** sum `amountIn` on buys and `deliveredOut` on sells for user-facing SOL volume, or use
`Pool.quoteVolume` for the pool's own total. **Candles:** bucket `priceAfter` by `ts`. The first
trade's open is the price before it, from the previous event's reserves or the launch's opening
reserves.

## Which transactions to read

A pool's address is in every swap on it, so `getSignaturesForAddress(pool)` lists a token's trades.
For the whole market, stream the DEX program (`GyzKSnnE…7hk`) with a websocket `logsSubscribe` /
`onLogs` mentioning it, or a Geyser transaction filter on it, and decode each transaction as above.
Graduation, claims and launches go through the launchpad and the kit; a companion's launch, fee
claims, buybacks and game steps through the companion. Subscribe to the programs whose events you
need.

## New launches

`launch.LaunchCreated`, from the launchpad's transactions, carries everything a new token row needs:
`mint`, `pool`, `creator`, `name`, `symbol`, `uri`, `supply`, `decimals`, the curve
(`virtualQuote`, `virtualBase`, `graduationQuote`, `curveTokens`, `reserveTokens`), the fees, the
`rules` with their `modules`, `config` and `customHook`.

## Every event

| Program | Events |
| --- | --- |
| token | `MintCreated`, `Minted`, `Burned`, `Transferred` (with each hook cut), `HoldingCreated`, `HoldingClosed`, `HookDataWritten`, `HookSet`, `AuthoritySet`, `DelegateSet`, `FrozenSet`, `MetadataUpdated` |
| swap (DEX) | `PoolCreated`, `Swapped`, `LiquidityAdded`, `LiquidityRemoved`, `CurveFinalized`, `ProtocolFeesCollected`, `ConfigSet` |
| launch | `LaunchCreated`, `Graduated`, `CreatorFeesClaimed`, `LaunchConfigCreated`, `ConfigListed`, `AuthorFeesPaid`, `ConfigSet` |
| kit | `KitInstalled`, `KitGraduated`, `RewardsClaimed`, `RewardsShared` |
| bridge | `WrapperRegistered`, `Wrapped`, `Unwrapped`, `ConfigSet` |
| companion | `CompanionCreated`, `CompanionLaunched`, `DevBought`, `DevReleased`, `FeesClaimed`, `BoughtBack`, `BuybackWaited`, `SharedWithHolders`, `BeneficiaryPaid`, `StrandedBurned`; games: `GameCreated`, `GameKindSet`, `PotFunded`, `PotToBuyback`, `PotRetired`, `HookStatusSet`; lottery: `DrawCommitted`, `DrawRequested`, `DrawRevealed`, `PrizePaid`, `RolledOver`; jackpot: `JackpotPaid`, `JackpotUnfunded`, `JackpotForfeited`; streak: `EpochClosed`, `EpochEnded`, `ShareClaimed` |
| lottery hook | `Prepared`, `Entered` |

`typedEvent` types the ones an indexer needs (`token.Transferred`, `token.HookDataWritten`,
`swap.Swapped`, `swap.ProtocolFeesCollected`, `launch.LaunchCreated`, `launch.LaunchConfigCreated`,
`launch.ConfigListed`, `launch.AuthorFeesPaid`, and the kit's four). Every other event is still in
`eventsOf`'s output as `{ program, name, data }`, with keys as base58 strings and integers as
decimal strings.

Half-Life's `Stoked` (the furnace burned) is a plain log event (`Program data:` in the logs), not
an event CPI. Watch the mint's `Burned` event from the token program instead, or decode the log
with the IDL.

## Companion and game events

`eventsOf` reads the companion's and the lottery hook's events only when asked, so the ordinals of
the other programs' events never change:

```ts
import { GAME_EVENT_PROGRAMS, INDEXED_EVENT_PROGRAMS } from '@bordrless/sdk';

const all = eventsOf(keys, inner, (data) => Buffer.from(bs58.decode(data)), [...INDEXED_EVENT_PROGRAMS, ...GAME_EVENT_PROGRAMS]);
const games = all.filter((e) => e.program === 'companion' || e.program === 'lotteryHook'); // untyped: { name, data }
```

Worth a row each:

| Event | What it records |
| --- | --- |
| `CompanionCreated`, `CompanionLaunched` | A companion's split, bounty, buyback limits and vesting; its launch. The launch's `LaunchCreated` has the companion's address as `creator` |
| `FeesClaimed`, `PotFunded` | A fee claim and how it was split (`toBuyback`, `toHolders`, `toBeneficiary`; a game's `toPot`, and `pendingPot` after) |
| `BoughtBack`, `BuybackWaited` | A buyback: SOL `spent`, tokens `burned`; or a wait while the price is above the reference. The same transaction has a `Swapped` whose `trader` is the companion's creator address |
| `DevBought`, `DevReleased` | The launcher's vesting buy, and what vested to them |
| `SharedWithHolders`, `BeneficiaryPaid` | SOL to holder rewards; SOL to the launcher |
| `GameCreated`, `GameKindSet` | A game's kind, hook and settings, before the launch |
| `DrawRequested`, `DrawRevealed`, `PrizePaid`, `RolledOver` | A lottery round: the draw (`prize`), ORAO's answer, the winner paid in SOL (`winner`, `prize`), or why nobody was (`reason`) |
| `JackpotPaid`, `JackpotUnfunded`, `JackpotForfeited` | A jackpot round settled: paid to `winner`, closed unpaid with the pot short, or forfeited (`reason`) |
| `EpochClosed`, `ShareClaimed`, `EpochEnded` | A streak epoch's pot fixed (`epochPot`, `total`), each holder's share paid, and what rolled over |
| `PotRetired`, `PotToBuyback`, `StrandedBurned` | A pot sent to the buyback (dormant, or its hook blocked) or burned; nobody is paid |
| lottery hook `Entered` | A holding registered for a round (`weight` tickets from `start`) |

**A game coin's hook data is ticket bookkeeping.** A game hook keeps, in each holding's 64 bytes
of hook data, its tickets (lottery) or weight (streak) for the current and the previous round,
when it last sent anything, and for a jackpot the mark of its qualifying buy (`decodeTicketSlots`,
`jackpotMark`; the layout is in
[games.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/games.md#the-game-ticket-standard-bordrless-game)).
It is never a balance. Game hooks' callbacks emit no event; the lottery hook's callback writes
follow from the token program's `Transferred` and `Burned` events and the clock alone, and its
`enter` emits `Entered`, so an indexer can replay them. Or read the holdings when you need the
current values.

## Graduation

A token graduated when `launch.Graduated` is emitted, or `Launch.status` reads 1. The same pool
keeps trading. Its virtual reserves drop to zero at that point and the reserve's top-up is added,
so the price is continuous across it.
